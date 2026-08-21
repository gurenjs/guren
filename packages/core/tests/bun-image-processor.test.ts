import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import {
  Attachable,
  configureAttachments,
  defineModel,
  DrizzleAdapter,
  hasOneAttached,
  StorageManager,
} from '../src/index'
import { resolveDefaultImageProcessor } from '../src/attachments/bun-image-processor'
import { setActiveAttachmentEngine } from '../src/attachments/engine'
import { sniffImage } from '../src/attachments/image-sniff'
import { ATTACHMENTS_DDL, attachmentsTable } from './attachments-table'
import { PNG_1X1 } from './image-sniff.test'

/**
 * These tests exercise the real `Bun.Image`, so they are gated on the same
 * feature check the processor resolution uses — Bun lanes without the API
 * (< 1.3.14) skip them and stay green.
 */
const hasBunImage = typeof Bun !== 'undefined' && 'Image' in Bun
const describeBunImage = hasBunImage ? describe : describe.skip

describeBunImage('BunImageProcessor', () => {
  const processor = resolveDefaultImageProcessor(52_000_000)!

  test('should be resolved by feature detection', () => {
    expect(processor).not.toBeNull()
  })

  test('should probe dimensions, format, and a ThumbHash placeholder', async () => {
    const probed = await processor.probe(PNG_1X1, { maxPixels: 52_000_000 })
    expect(probed.width).toBe(1)
    expect(probed.height).toBe(1)
    expect(probed.format).toBe('png')
    expect(probed.placeholder).toStartWith('data:image/')
  })

  test('should reject truncated bytes that pass header sniffing', async () => {
    // The header parses, so metadata() alone would accept it — only the
    // full decode catches the lie.
    const truncated = PNG_1X1.slice(0, 40)
    expect(sniffImage(truncated)?.format).toBe('png')
    await expect(processor.probe(truncated, { maxPixels: 52_000_000 })).rejects.toThrow()
  })

  test('should enforce maxPixels at decode time', async () => {
    const upscaled = await processor.process(PNG_1X1, { width: 8, height: 8, fit: 'fill', format: 'png' })
    await expect(processor.probe(upscaled.bytes, { maxPixels: 4 })).rejects.toThrow()
  })

  test('should resize and re-encode to the requested format', async () => {
    const result = await processor.process(PNG_1X1, { width: 4, height: 4, fit: 'fill', format: 'webp' })
    expect(result.width).toBe(4)
    expect(result.height).toBe(4)
    expect(result.format).toBe('webp')
    expect(sniffImage(result.bytes)?.format).toBe('webp')
  })

  test('should derive the width for a height-only spec', async () => {
    const result = await processor.process(PNG_1X1, { height: 3, format: 'png' })
    expect(result.height).toBe(3)
    expect(result.width).toBeGreaterThan(0)
  })
})

const photos = sqliteTable('photos', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
})

class Photo extends Attachable(defineModel(photos), {
  cover: hasOneAttached({ image: 'require', variants: { thumb: { width: 2, fit: 'fill', format: 'webp' } } }),
}) {}

describeBunImage('attachments end-to-end with the default processor', () => {
  let sqlite: Database
  let storage: StorageManager

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(ATTACHMENTS_DDL)
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
    storage = new StorageManager({
      default: 'media',
      disks: { media: { driver: 'memory', url: 'https://cdn.test' } },
    })
    // No `processor` key: the engine resolves Bun.Image by itself.
    configureAttachments({ table: attachmentsTable, storage: () => storage, disk: 'media' })
  })

  afterEach(() => {
    sqlite.close()
    setActiveAttachmentEngine(null)
  })

  test('should decode, measure, placeholder, and generate variants inline', async () => {
    const record = await Photo.attach(1, 'cover', new File([PNG_1X1], 'cover.png', { type: 'image/png' }))

    expect(record.width).toBe(1)
    expect(record.height).toBe(1)
    expect(record.placeholder).toStartWith('data:image/')

    const thumb = record.variants?.thumb
    expect(thumb?.status).toBe('ready')
    expect(thumb?.format).toBe('webp')
    expect(thumb?.width).toBe(2)
    const stored = await storage.disk('media').get(thumb!.path!)
    expect(sniffImage(new Uint8Array(stored!))?.format).toBe('webp')
  })

  test('should reject truncated image bytes with 422 through the full-decode gate', async () => {
    const error = await Photo.attach(1, 'cover', PNG_1X1.slice(0, 40)).catch((e) => e)
    expect(error.statusCode).toBe(422)
  })
})

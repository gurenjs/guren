import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Attachable,
  configureAttachments,
  defineModel,
  DrizzleAdapter,
  hasManyAttached,
  hasOneAttached,
  HttpException,
  MemoryStorageDriver,
  StorageManager,
  ValidationException,
  type AttachmentVariantRecord,
  type ConfigureAttachmentsOptions,
  type ImageProcessor,
} from '../src/index'
import { sanitizeFilename, setActiveAttachmentEngine } from '../src/attachments/engine'
import { isoBmffHeader, PNG_1X1, pngWithDeclaredDimensions } from './image-sniff.test'

const attachmentsTable = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  attachableType: text('attachable_type').notNull(),
  attachableId: text('attachable_id').notNull(),
  collection: text('collection').notNull().default('default'),
  disk: text('disk').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  variants: text('variants', { mode: 'json' }).$type<Record<string, AttachmentVariantRecord>>(),
  placeholder: text('placeholder'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

const posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
})

class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached({ image: 'require', variants: { thumb: { width: 2, format: 'png' } } }),
  images: hasManyAttached({ image: 'require' }),
  draftPdf: hasOneAttached(),
  photo: hasOneAttached({ image: 'require', accepts: { heic: 'convert' } }),
  banner: hasOneAttached({ image: 'allow' }),
  report: hasOneAttached({ image: 'forbid' }),
}) {}

/**
 * Deterministic stand-in for the runtime processor, so the decode-path tests
 * pass identically on every Bun lane. The real BunImageProcessor is covered
 * by bun-image-processor.test.ts behind the `'Image' in Bun` gate.
 */
function fakeProcessor(overrides: Partial<ImageProcessor> = {}): ImageProcessor {
  return {
    async probe(input) {
      if (input.length >= 24 && input[0] === 0x89 && input[1] === 0x50) {
        const view = new DataView(input.buffer, input.byteOffset)
        return {
          width: view.getUint32(16),
          height: view.getUint32(20),
          format: 'png',
          placeholder: 'data:image/png;base64,lqip',
        }
      }
      if (input.length > 11 && String.fromCharCode(...input.slice(4, 8)) === 'ftyp') {
        return { width: 5, height: 5, format: 'heic', placeholder: 'data:image/png;base64,lqip' }
      }
      throw Object.assign(new Error('decode failed'), { code: 'ERR_IMAGE_DECODE_FAILED' })
    },
    async process(_input, spec) {
      return {
        bytes: new Uint8Array([1, 2, 3, 4]),
        width: spec.width ?? 7,
        height: spec.height ?? 7,
        format: spec.format ?? 'jpeg',
      }
    },
    ...overrides,
  }
}

describe('attachments', () => {
  let sqlite: Database
  let storage: StorageManager

  function configure(overrides: Partial<ConfigureAttachmentsOptions> = {}) {
    return configureAttachments({
      table: attachmentsTable,
      storage: () => storage,
      disk: 'media',
      processor: null,
      ...overrides,
    })
  }

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE attachments (
        id text primary key,
        attachable_type text not null,
        attachable_id text not null,
        collection text not null default 'default',
        disk text not null,
        path text not null,
        name text not null,
        content_type text not null,
        size integer not null,
        width integer,
        height integer,
        variants text,
        placeholder text,
        created_at integer not null,
        updated_at integer not null
      );
      CREATE TABLE posts (id integer primary key, title text not null);
    `)
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
    storage = new StorageManager({
      default: 'media',
      disks: {
        media: { driver: 'memory', url: 'https://cdn.test' },
      },
    })
    configure()
  })

  afterEach(() => {
    sqlite.close()
    setActiveAttachmentEngine(null)
  })

  describe('attach', () => {
    test('should store the original and create a row', async () => {
      const record = await Post.attach(1, 'cover', new File([PNG_1X1], 'cover.png', { type: 'image/png' }))

      expect(record.attachableType).toBe('Post')
      expect(record.attachableId).toBe('1')
      expect(record.collection).toBe('cover')
      expect(record.disk).toBe('media')
      expect(record.path).toBe(`attachments/${record.id}/cover.png`)
      expect(record.name).toBe('cover.png')
      expect(record.contentType).toBe('image/png')
      expect(record.size).toBe(PNG_1X1.byteLength)
      // No processor configured: dimensions come from the header gate.
      expect(record.width).toBe(1)
      expect(record.height).toBe(1)
      expect(record.placeholder).toBeNull()
      expect(await storage.disk('media').exists(record.path)).toBe(true)
    })

    test('should reject path strings at runtime', async () => {
      await expect(
        // @ts-expect-error path strings are rejected by the types too
        Post.attach(1, 'cover', '/etc/passwd'),
      ).rejects.toThrow(TypeError)
    })

    test('should throw on an undeclared collection', async () => {
      await expect(
        // @ts-expect-error undeclared collection
        Post.attach(1, 'gallery', PNG_1X1),
      ).rejects.toThrow("declares no attachment collection 'gallery'")
    })

    test('should throw a clear error when configureAttachments was never called', async () => {
      setActiveAttachmentEngine(null)
      expect(() => Post.attach(1, 'cover', PNG_1X1)).toThrow('configureAttachments')
    })

    test('should reject non-image bytes on an image: require collection with 422', async () => {
      const error = await Post.attach(1, 'cover', new Uint8Array(Buffer.from('%PDF-1.7'))).catch((e) => e)
      expect(error).toBeInstanceOf(ValidationException)
      expect(error.statusCode).toBe(422)
      expect(error.errors.cover).toBeDefined()
    })

    test('should reject oversized encoded input with 413 before any decode', async () => {
      configure({ maxImageBytes: 10 })
      const error = await Post.attach(1, 'cover', PNG_1X1).catch((e) => e)
      expect(error).toBeInstanceOf(HttpException)
      expect(error.statusCode).toBe(413)
    })

    test('should reject header-declared dimensions above maxPixels with 422', async () => {
      const error = await Post.attach(1, 'cover', pngWithDeclaredDimensions(100_000, 100_000)).catch(
        (e) => e,
      )
      expect(error).toBeInstanceOf(ValidationException)
      expect(error.statusCode).toBe(422)
      expect(String(error.errors.cover)).toContain('100000x100000')
    })

    test('should reject HEIC with 415 by default, without decoding', async () => {
      const error = await Post.attach(1, 'cover', isoBmffHeader('heic')).catch((e) => e)
      expect(error).toBeInstanceOf(HttpException)
      expect(error.statusCode).toBe(415)
    })

    test('should reject HEIC with 415 when heic: convert has no processor to convert with', async () => {
      const error = await Post.attach(1, 'photo', isoBmffHeader('heic')).catch((e) => e)
      expect(error.statusCode).toBe(415)
    })

    test('should convert HEIC to JPEG when heic: convert has a processor', async () => {
      configure({ processor: fakeProcessor() })
      const record = await Post.attach(1, 'photo', new File([isoBmffHeader('heic')], 'shot.heic'))
      expect(record.contentType).toBe('image/jpeg')
      expect(record.name).toBe('shot.jpg')
      expect(record.width).toBe(7)
    })

    test('should answer 415 when the processor reports ERR_IMAGE_FORMAT_UNSUPPORTED', async () => {
      configure({
        processor: fakeProcessor({
          async probe() {
            throw Object.assign(new Error('no codec'), { code: 'ERR_IMAGE_FORMAT_UNSUPPORTED' })
          },
        }),
      })
      const error = await Post.attach(1, 'cover', PNG_1X1).catch((e) => e)
      expect(error.statusCode).toBe(415)
    })

    test('should reject bytes that decode-fail on a require collection with 422', async () => {
      configure({
        processor: fakeProcessor({
          async probe() {
            throw Object.assign(new Error('decode failed'), { code: 'ERR_IMAGE_DECODE_FAILED' })
          },
        }),
      })
      const error = await Post.attach(1, 'cover', PNG_1X1).catch((e) => e)
      expect(error).toBeInstanceOf(ValidationException)
    })

    test('should store opaque bytes without image handling on an undeclared-image collection', async () => {
      const pdf = new File([new Uint8Array(Buffer.from('%PDF-1.7 content'))], 'draft.pdf', {
        type: 'application/pdf',
      })
      const record = await Post.attach(1, 'draftPdf', pdf)
      expect(record.contentType).toBe('application/pdf')
      expect(record.width).toBeNull()
      expect(record.height).toBeNull()
      expect(record.placeholder).toBeNull()
      // Even HEIC bytes are fine here — no image pipeline runs at all.
      await Post.attach(2, 'draftPdf', isoBmffHeader('heic'))
    })

    test('should store non-image bytes as opaque on an image: allow collection', async () => {
      const record = await Post.attach(1, 'banner', new Uint8Array(Buffer.from('plain text')))
      expect(record.width).toBeNull()
    })

    test('should measure images on an image: allow collection', async () => {
      const record = await Post.attach(1, 'banner', PNG_1X1, { name: 'banner.png' })
      expect(record.width).toBe(1)
      expect(record.contentType).toBe('image/png')
    })

    test('should reject images on an image: forbid collection with 422', async () => {
      const error = await Post.attach(1, 'report', PNG_1X1).catch((e) => e)
      expect(error).toBeInstanceOf(ValidationException)
      await Post.attach(1, 'report', new Uint8Array(Buffer.from('csv,data')))
    })

    test('should replace the previous attachment on a hasOne collection', async () => {
      const first = await Post.attach(1, 'cover', PNG_1X1, { name: 'first.png' })
      const second = await Post.attach(1, 'cover', PNG_1X1, { name: 'second.png' })

      const [loaded] = await Post.withAttachments([{ id: 1 }], ['cover'])
      expect(loaded!.cover?.id).toBe(second.id)
      expect(await storage.disk('media').exists(first.path)).toBe(false)
      expect(await storage.disk('media').exists(second.path)).toBe(true)
    })

    test('should append on a hasMany collection', async () => {
      await Post.attach(1, 'images', PNG_1X1, { name: 'a.png' })
      await Post.attach(1, 'images', PNG_1X1, { name: 'b.png' })

      const [loaded] = await Post.withAttachments([{ id: 1 }], ['images'])
      expect(loaded!.images).toHaveLength(2)
    })

    test('should sanitize traversal-shaped filenames', async () => {
      const record = await Post.attach(1, 'cover', PNG_1X1, { name: '../../../evil.png' })
      expect(record.name).toBe('evil.png')
      expect(record.path).toBe(`attachments/${record.id}/evil.png`)
    })
  })

  describe('variants', () => {
    test('should record declared variants as unavailable without a processor', async () => {
      const record = await Post.attach(1, 'cover', PNG_1X1)
      expect(record.variants).toEqual({ thumb: { status: 'unavailable' } })
    })

    test('should generate declared variants inline with a processor', async () => {
      configure({ processor: fakeProcessor() })
      const record = await Post.attach(1, 'cover', PNG_1X1)

      const thumb = record.variants?.thumb
      expect(thumb?.status).toBe('ready')
      expect(thumb?.path).toBe(`attachments/${record.id}/variants/thumb.png`)
      expect(thumb?.width).toBe(2)
      expect(await storage.disk('media').exists(thumb!.path!)).toBe(true)
      expect(record.placeholder).toBe('data:image/png;base64,lqip')
    })

    test('should record a variant as failed when generation throws', async () => {
      configure({
        processor: fakeProcessor({
          async process() {
            throw new Error('encoder exploded')
          },
        }),
      })
      const record = await Post.attach(1, 'cover', PNG_1X1)
      expect(record.variants?.thumb?.status).toBe('failed')
    })
  })

  describe('withAttachments', () => {
    test('should attach hasOne as nullable-single and hasMany as array', async () => {
      await Post.attach(1, 'cover', PNG_1X1, { name: 'cover.png' })
      await Post.attach(1, 'images', PNG_1X1, { name: 'a.png' })
      await Post.attach(1, 'images', PNG_1X1, { name: 'b.png' })

      const records = [
        { id: 1, title: 'with attachments' },
        { id: 2, title: 'without' },
      ]
      const [first, second] = await Post.withAttachments(records, ['cover', 'images'])

      expect(first!.title).toBe('with attachments')
      expect(first!.cover?.name).toBe('cover.png')
      expect(first!.cover?.url).toContain(`attachments/`)
      expect(first!.images.map((image) => image.name)).toEqual(['a.png', 'b.png'])
      expect(second!.cover).toBeNull()
      expect(second!.images).toEqual([])
    })

    test('should expose declared variants with fallback URLs until they are ready', async () => {
      await Post.attach(1, 'cover', PNG_1X1) // no processor: thumb is unavailable
      const [loaded] = await Post.withAttachments([{ id: 1 }], ['cover'])
      const cover = loaded!.cover!
      expect(cover.variants.thumb).toBeDefined()
      expect(cover.variants.thumb!.url).toBe(cover.url)
    })
  })

  describe('attachmentUrl', () => {
    test('should return null when nothing is attached', async () => {
      expect(await Post.attachmentUrl(1, 'cover')).toBeNull()
    })

    test('should build the original URL from the disk', async () => {
      const record = await Post.attach(1, 'cover', PNG_1X1)
      const url = await Post.attachmentUrl(1, 'cover')
      expect(url).toContain(record.path)
    })

    test('should serve a ready variant and fall back to the original otherwise', async () => {
      configure({ processor: fakeProcessor() })
      const ready = await Post.attach(1, 'cover', PNG_1X1)
      expect(await Post.attachmentUrl(1, 'cover', { variant: 'thumb' })).toContain(
        `attachments/${ready.id}/variants/thumb.png`,
      )

      configure() // processor: null → unavailable
      const fallback = await Post.attach(2, 'cover', PNG_1X1)
      expect(await Post.attachmentUrl(2, 'cover', { variant: 'thumb' })).toContain(fallback.path)
    })

    test('should throw for a variant name that was never declared', async () => {
      await Post.attach(1, 'cover', PNG_1X1)
      await expect(
        // @ts-expect-error undeclared variant name
        Post.attachmentUrl(1, 'cover', { variant: 'huge' }),
      ).rejects.toThrow("variant 'huge' is not declared")
    })

    test('should use temporaryUrl on disks declared private', async () => {
      storage.registerDisk('vault', () => {
        const driver = new MemoryStorageDriver({ url: 'https://vault.test' })
        driver.temporaryUrl = async (path: string) => `https://vault.test/${path}?signature=stub`
        return driver
      })
      configure({ disks: { vault: 'private' } })

      await Post.attach(1, 'draftPdf', new Uint8Array(Buffer.from('secret')), { disk: 'vault' })
      const url = await Post.attachmentUrl(1, 'draftPdf')
      expect(url).toContain('?signature=stub')
    })
  })

  describe('detach and purge', () => {
    test('should remove one hasMany attachment by id', async () => {
      const first = await Post.attach(1, 'images', PNG_1X1, { name: 'a.png' })
      await Post.attach(1, 'images', PNG_1X1, { name: 'b.png' })

      await Post.detach(1, 'images', first.id)

      const [loaded] = await Post.withAttachments([{ id: 1 }], ['images'])
      expect(loaded!.images.map((image) => image.name)).toEqual(['b.png'])
      expect(await storage.disk('media').exists(first.path)).toBe(false)
    })

    test('should remove the whole collection without an id', async () => {
      await Post.attach(1, 'images', PNG_1X1)
      await Post.attach(1, 'images', PNG_1X1)
      await Post.detach(1, 'images')
      const [loaded] = await Post.withAttachments([{ id: 1 }], ['images'])
      expect(loaded!.images).toEqual([])
    })

    test('should reject an attachment id on a hasOne collection', async () => {
      await expect(
        // @ts-expect-error hasOne takes no attachment id
        Post.detach(1, 'cover', 'some-id'),
      ).rejects.toThrow('hasOne')
    })

    test('should purge every collection of a record', async () => {
      const cover = await Post.attach(1, 'cover', PNG_1X1)
      const image = await Post.attach(1, 'images', PNG_1X1)
      const other = await Post.attach(2, 'cover', PNG_1X1)

      await Post.purgeAttachments(1)

      const [one, two] = await Post.withAttachments([{ id: 1 }, { id: 2 }], ['cover', 'images'])
      expect(one!.cover).toBeNull()
      expect(one!.images).toEqual([])
      expect(two!.cover?.id).toBe(other.id)
      expect(await storage.disk('media').exists(cover.path)).toBe(false)
      expect(await storage.disk('media').exists(image.path)).toBe(false)
      expect(await storage.disk('media').exists(other.path)).toBe(true)
    })
  })

  describe('local disk', () => {
    test('should round-trip attach, url, and detach on the local driver', async () => {
      const root = mkdtempSync(join(tmpdir(), 'guren-attachments-'))
      try {
        storage = new StorageManager({
          default: 'media',
          disks: { media: { driver: 'local', root, url: '/storage' } },
        })
        configure()

        const record = await Post.attach(1, 'cover', new File([PNG_1X1], 'cover.png'))
        expect(await storage.disk('media').exists(record.path)).toBe(true)
        expect(await Post.attachmentUrl(1, 'cover')).toContain(record.path)

        await Post.detach(1, 'cover')
        expect(await storage.disk('media').exists(record.path)).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
})

describe('sanitizeFilename', () => {
  test('should strip path segments and control characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('C:\\Users\\evil.png')).toBe('evil.png')
    expect(sanitizeFilename('name\u0000with\u001fcontrol.png')).toBe('namewithcontrol.png')
  })

  test('should never return an empty or dot-only name', () => {
    expect(sanitizeFilename('')).toBe('file')
    expect(sanitizeFilename('..')).toBe('file')
    expect(sanitizeFilename('images/')).toBe('file')
  })
})

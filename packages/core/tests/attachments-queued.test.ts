import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import {
  Attachable,
  configureAttachments,
  defineModel,
  DrizzleAdapter,
  hasManyAttached,
  hasOneAttached,
  MemoryQueueDriver,
  processJob,
  QueueManager,
  setQueueDriver,
  StorageManager,
  SyncQueueDriver,
  type ConfigureAttachmentsOptions,
  type Model,
} from '../src/index'
import { setActiveAttachmentEngine } from '../src/attachments/engine'
import { GenerateVariantsJob } from '../src/attachments/generate-variants-job'
import { fakeProcessor } from './attachments-processor'
import { ATTACHMENTS_DDL, attachmentsTable } from './attachments-table'
import { isoBmffHeader, PNG_1X1 } from './image-sniff.test'

const posts = sqliteTable('queued_posts', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
})

class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached({ image: 'require', variants: { thumb: { width: 2, format: 'png' } } }),
  images: hasManyAttached({ image: 'require' }),
  photo: hasOneAttached({ image: 'require', accepts: { heic: 'convert' } }),
  banner: hasOneAttached({ image: 'allow' }),
  draftPdf: hasOneAttached(),
}) {}

describe('attachments queued generation', () => {
  let sqlite: Database
  let storage: StorageManager
  let queueDriver: MemoryQueueDriver
  let Attachment: typeof Model

  function configure(overrides: Partial<ConfigureAttachmentsOptions> = {}) {
    const configured = configureAttachments({
      table: attachmentsTable,
      storage: () => storage,
      disk: 'media',
      processor: fakeProcessor(),
      queue: () => new QueueManager({ default: 'memory', drivers: { memory: () => queueDriver } }),
      ...overrides,
    })
    Attachment = configured.Attachment
    return configured
  }

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(ATTACHMENTS_DDL)
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
    storage = new StorageManager({
      default: 'media',
      disks: { media: { driver: 'memory', url: 'https://cdn.test' } },
    })
    queueDriver = new MemoryQueueDriver()
    configure()
  })

  afterEach(() => {
    sqlite.close()
    setActiveAttachmentEngine(null)
  })

  async function runQueuedJob(): Promise<void> {
    expect(await processJob(queueDriver, 'default')).toBe(true)
  }

  async function rowOf(id: string) {
    return (await Attachment.where({ id }).first()) as Record<string, unknown> | null
  }

  test('should seed pending variants and defer the decode to the worker', async () => {
    const record = await Post.attach(1, 'cover', new File([PNG_1X1], 'cover.png'), { queued: true })

    // Request path: header evidence only, even though a processor exists.
    expect(record.variants).toEqual({ thumb: { status: 'pending' } })
    expect(record.width).toBe(1)
    expect(record.placeholder).toBeNull()
    expect(await queueDriver.size('default')).toBe(1)

    await runQueuedJob()

    const row = (await rowOf(record.id))!
    const variants = row.variants as Record<string, { status: string; path?: string }>
    expect(variants.thumb!.status).toBe('ready')
    expect(await storage.disk('media').exists(variants.thumb!.path!)).toBe(true)
    expect(row.placeholder).toBe('data:image/png;base64,lqip')
  })

  test('should complete inline on a sync queue driver', async () => {
    const sync = new SyncQueueDriver()
    configure({ queue: () => new QueueManager({ default: 'sync', drivers: { sync: () => sync } }) })

    const record = await Post.attach(1, 'cover', PNG_1X1, { queued: true, name: 'cover.png' })

    const row = (await rowOf(record.id))!
    const variants = row.variants as Record<string, { status: string }>
    expect(variants.thumb!.status).toBe('ready')
  })

  test('should fail fast when no queue is configured, before writing anything', async () => {
    configure({ queue: undefined })
    // Earlier tests installed a global driver; clear it so the fallback
    // genuinely has nothing to dispatch through.
    setQueueDriver(null as unknown as Parameters<typeof setQueueDriver>[0])
    await expect(Post.attach(1, 'cover', PNG_1X1, { queued: true })).rejects.toThrow(
      'queued: true requires a queue',
    )
    expect(await Attachment.where({ attachableId: '1' })).toEqual([])
  })

  test('should reject a queue option that is not a QueueManager', async () => {
    configure({ queue: () => ({ notADriver: true }) })
    await expect(Post.attach(1, 'cover', PNG_1X1, { queued: true })).rejects.toThrow('QueueManager')
  })

  test('should purge a lying image on a require collection when the deferred decode fails', async () => {
    configure({
      processor: fakeProcessor({
        async probe() {
          throw Object.assign(new Error('decode failed'), { code: 'ERR_IMAGE_DECODE_FAILED' })
        },
      }),
    })
    // Passes the header gates, fails the decode — exactly the class queued
    // acceptance lets through provisionally.
    const record = await Post.attach(1, 'cover', PNG_1X1, { queued: true, name: 'liar.png' })
    expect(record.variants?.thumb?.status).toBe('pending')

    await runQueuedJob()

    expect(await rowOf(record.id)).toBeNull()
    expect(await storage.disk('media').exists(record.path)).toBe(false)
  })

  test('should keep an image-optional upload as opaque when the deferred decode fails', async () => {
    configure({
      processor: fakeProcessor({
        async probe() {
          throw Object.assign(new Error('decode failed'), { code: 'ERR_IMAGE_DECODE_FAILED' })
        },
      }),
    })
    const record = await Post.attach(1, 'banner', PNG_1X1, { queued: true, name: 'banner.png' })
    expect(record.width).toBe(1) // header evidence at accept time

    await runQueuedJob()

    const row = (await rowOf(record.id))!
    expect(row.width).toBeNull()
    expect(await storage.disk('media').exists(record.path)).toBe(true)
  })

  test('should convert a queued HEIC original to JPEG in the worker', async () => {
    const record = await Post.attach(1, 'photo', new File([isoBmffHeader('heic')], 'shot.heic'), {
      queued: true,
    })
    // Stored as-is until the worker runs — the request path never decodes.
    expect(record.contentType).toBe('image/heic')
    expect(record.name).toBe('shot.heic')

    await runQueuedJob()

    const row = (await rowOf(record.id))!
    expect(row.contentType).toBe('image/jpeg')
    expect(row.name).toBe('shot.jpg')
    expect(row.path).toBe(`attachments/${record.id}/shot.jpg`)
    expect(await storage.disk('media').exists(String(row.path))).toBe(true)
    expect(await storage.disk('media').exists(record.path)).toBe(false)
  })

  test('should repoint the row before deleting the superseded HEIC original', async () => {
    // A delete that fails must not fail the job: by then the row already
    // points at the converted object, and the superseded original is a
    // leak for the sweeper — the reverse order would risk a row pointing
    // at nothing.
    const record = await Post.attach(1, 'photo', new File([isoBmffHeader('heic')], 'shot.heic'), {
      queued: true,
    })
    const disk = storage.disk('media')
    const originalDelete = disk.delete.bind(disk)
    disk.delete = async (path: string) => {
      if (path === record.path) throw new Error('delete refused')
      return originalDelete(path)
    }

    await runQueuedJob()

    const row = (await rowOf(record.id))!
    expect(row.path).toBe(`attachments/${record.id}/shot.jpg`)
    expect(await disk.exists(String(row.path))).toBe(true)
    // The superseded original leaked (delete refused) — but the link is intact.
    expect(await disk.exists(record.path)).toBe(true)
  })

  test('should settle pending variants as unavailable on a worker without a processor', async () => {
    configure({ processor: null })
    const record = await Post.attach(1, 'cover', PNG_1X1, { queued: true, name: 'cover.png' })
    expect(record.variants?.thumb?.status).toBe('pending')

    await runQueuedJob()

    const row = (await rowOf(record.id))!
    const variants = row.variants as Record<string, { status: string }>
    expect(variants.thumb!.status).toBe('unavailable')
  })

  test('should settle pending variants as failed after the last retry', async () => {
    const record = await Post.attach(1, 'cover', PNG_1X1, { queued: true, name: 'cover.png' })

    const job = new GenerateVariantsJob()
    await job.failed({ attachmentId: record.id }, new Error('worker crashed'))

    const row = (await rowOf(record.id))!
    const variants = row.variants as Record<string, { status: string }>
    expect(variants.thumb!.status).toBe('failed')
  })

  test('should not dispatch for collections without an image pipeline', async () => {
    await Post.attach(1, 'draftPdf', new Uint8Array(Buffer.from('%PDF-1.7')), {
      queued: true,
      name: 'draft.pdf',
    })
    expect(await queueDriver.size('default')).toBe(0)
  })

  test('should do nothing when the attachment was purged before the job ran', async () => {
    await Post.attach(1, 'cover', PNG_1X1, { queued: true, name: 'cover.png' })
    await Post.detach(1, 'cover')

    await runQueuedJob() // must not throw

    expect(await Attachment.where({ attachableId: '1' })).toEqual([])
  })

  test('should undo the provisional accept when the dispatch itself fails', async () => {
    const brokenDriver = {
      async push() {
        throw new Error('redis is down')
      },
    }
    configure({
      queue: () =>
        new QueueManager({ default: 'broken', drivers: { broken: () => brokenDriver as never } }),
    })

    const error = await Post.attach(1, 'cover', PNG_1X1, { queued: true, name: 'cover.png' }).catch(
      (e) => e,
    )
    expect(error.message).toContain('redis is down')

    // No job will ever validate these bytes — the row and object are gone,
    // not left serving an undecoded upload forever.
    expect(await Attachment.where({ attachableId: '1' })).toEqual([])
  })

  test('should keep the previous hasOne attachment when a replacing dispatch fails', async () => {
    const first = await Post.attach(1, 'cover', PNG_1X1, { queued: true, name: 'first.png' })
    await runQueuedJob()

    const brokenDriver = {
      async push() {
        throw new Error('redis is down')
      },
    }
    configure({
      queue: () =>
        new QueueManager({ default: 'broken', drivers: { broken: () => brokenDriver as never } }),
    })
    const error = await Post.attach(1, 'cover', PNG_1X1, { queued: true, name: 'second.png' }).catch(
      (e) => e,
    )
    expect(error.message).toContain('redis is down')

    // The replace is rolled back: the first attachment is still there.
    expect(await rowOf(first.id)).not.toBeNull()
    expect(await storage.disk('media').exists(first.path)).toBe(true)
    const rows = (await Attachment.where({ attachableId: '1' })) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
  })

  test('should purge a require HEIC convert on a worker that cannot convert at all', async () => {
    configure({ processor: null })
    const record = await Post.attach(1, 'photo', isoBmffHeader('heic'), { queued: true, name: 'shot.heic' })

    await runQueuedJob()

    // The sync path only accepted this because conversion was promised; a
    // worker without any processor cannot keep it, and photo requires an
    // image — so the HEIC must not stay live.
    expect(await rowOf(record.id)).toBeNull()
    expect(await storage.disk('media').exists(record.path)).toBe(false)
  })

  test('should not clobber ready variants when a stale settlement lands afterwards', async () => {
    const record = await Post.attach(1, 'cover', PNG_1X1, { queued: true, name: 'cover.png' })
    await runQueuedJob()

    // A duplicate delivery's failure path settles on a fresh read: with no
    // pending entries left, it must leave the completed variants alone.
    const job = new GenerateVariantsJob()
    await job.failed({ attachmentId: record.id }, new Error('duplicate delivery crashed'))

    const row = (await rowOf(record.id))!
    const variants = row.variants as Record<string, { status: string }>
    expect(variants.thumb!.status).toBe('ready')
  })

  test('should clean up its own objects when the row vanished mid-job', async () => {
    let victim: string | null = null
    configure({
      processor: fakeProcessor({
        async process(_input, spec) {
          // Simulate a replace/detach landing while the worker generates:
          // the row disappears between the decode and the final write.
          if (victim) await Attachment.where({ id: victim }).delete()
          return { bytes: new Uint8Array([1, 2, 3]), width: spec.width ?? 1, height: spec.height ?? 1, format: 'png' }
        },
      }),
    })

    const record = await Post.attach(1, 'cover', PNG_1X1, { queued: true, name: 'cover.png' })
    victim = record.id

    await runQueuedJob()

    expect(await rowOf(record.id)).toBeNull()
    // No orphans: the job removed everything it wrote under the prefix.
    expect(await storage.disk('media').exists(record.path)).toBe(false)
    expect(
      await storage.disk('media').exists(`attachments/${record.id}/variants/thumb.png`),
    ).toBe(false)
  })

  test('should still replace the previous hasOne attachment when queued', async () => {
    const first = await Post.attach(1, 'cover', PNG_1X1, { queued: true, name: 'first.png' })
    const second = await Post.attach(1, 'cover', PNG_1X1, { queued: true, name: 'second.png' })

    expect(await rowOf(first.id)).toBeNull()
    expect(await storage.disk('media').exists(first.path)).toBe(false)
    expect(await rowOf(second.id)).not.toBeNull()
  })
})

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import {
  Attachable,
  AttachmentsPruneCommand,
  configureAttachments,
  defineModel,
  DrizzleAdapter,
  hasOneAttached,
  Model,
  Output,
  StorageManager,
} from '../src/index'
import { resolveAttachmentEngine, setActiveAttachmentEngine } from '../src/attachments/engine'
import { ATTACHMENTS_DDL, attachmentsTable } from './attachments-table'
import { PNG_1X1 } from './image-sniff.test'

const prunePosts = sqliteTable('prune_posts', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
})

class Post extends Attachable(defineModel(prunePosts), {
  cover: hasOneAttached({ image: 'require' }),
  draftPdf: hasOneAttached(),
}) {}

/**
 * A ULID whose timestamp half is two hours old — past the one-hour grace
 * window `--objects` gives a rowless prefix, so the sweep treats it as debris
 * rather than an attach in flight.
 *
 * Hand-encoded rather than `ulid(twoHoursAgo)` because the generator is
 * monotonic: it clamps a backdated timestamp to the last one it issued, so
 * any earlier attach() in this suite would hand back a *fresh* id instead.
 */
function staleUlid(): string {
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let time = Date.now() - 2 * 60 * 60 * 1000
  let encoded = ''
  for (let i = 0; i < 10; i++) {
    encoded = ENCODING[time % 32]! + encoded
    time = Math.floor(time / 32)
  }
  return `${encoded}${'A'.repeat(16)}`
}

describe('attachments prune', () => {
  let sqlite: Database
  let storage: StorageManager
  let Attachment: typeof Model

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      ${ATTACHMENTS_DDL}
      CREATE TABLE prune_posts (id integer primary key, title text not null);
    `)
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
    storage = new StorageManager({
      default: 'media',
      disks: { media: { driver: 'memory', url: 'https://cdn.test' } },
    })
    const configured = configureAttachments({
      table: attachmentsTable,
      storage: () => storage,
      disk: 'media',
      processor: null,
    })
    Attachment = configured.Attachment
    Model.morphMap = { Post }
  })

  afterEach(() => {
    sqlite.close()
    setActiveAttachmentEngine(null)
    Model.morphMap = undefined
  })

  function engine() {
    return resolveAttachmentEngine('test')
  }

  test('should remove rows whose record no longer exists, objects first', async () => {
    await Post.forceCreate({ id: 1, title: 'alive' })
    const kept = await Post.attach(1, 'cover', PNG_1X1, { name: 'kept.png' })
    const orphan = await Post.attach(99, 'cover', PNG_1X1, { name: 'orphan.png' })

    const report = await engine().pruneOrphans()

    expect(report.scannedRows).toBe(2)
    expect(report.orphanRows).toEqual([
      { id: orphan.id, attachableType: 'Post', attachableId: '99' },
    ])
    expect(report.skippedTypes).toEqual([])
    expect(await Attachment.where({ id: orphan.id }).first()).toBeNull()
    expect(await storage.disk('media').exists(orphan.path)).toBe(false)
    expect(await Attachment.where({ id: kept.id }).first()).not.toBeNull()
    expect(await storage.disk('media').exists(kept.path)).toBe(true)
  })

  test('should match text attachable ids against numeric record keys', async () => {
    // The morph column stores '1'; the posts key is integer 1. A
    // representation mismatch must never make a live record look deleted.
    await Post.forceCreate({ id: 1, title: 'alive' })
    const kept = await Post.attach(1, 'cover', PNG_1X1)

    const report = await engine().pruneOrphans()

    expect(report.orphanRows).toEqual([])
    expect(await Attachment.where({ id: kept.id }).first()).not.toBeNull()
  })

  test('should keep attachments of a soft-deleted record so restore still works', async () => {
    const { SoftDeletes } = await import('../src/index')
    const softPosts = sqliteTable('prune_posts_soft', {
      id: integer('id').primaryKey(),
      title: text('title').notNull(),
      deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    })
    sqlite.exec('CREATE TABLE prune_posts_soft (id integer primary key, title text not null, deleted_at integer)')
    class SoftPost extends SoftDeletes(defineModel(softPosts)) {}
    Object.defineProperty(SoftPost, 'name', { value: 'Post' })
    Model.morphMap = { Post: SoftPost }

    await SoftPost.forceCreate({ id: 1, title: 'trashed later' })
    const kept = await Post.attach(1, 'cover', PNG_1X1)
    await SoftPost.delete({ id: 1 }) // soft delete: the record must stay restorable
    expect(await SoftPost.where({ id: 1 }).first()).toBeNull() // the scope hides it...

    const report = await engine().pruneOrphans()

    // ...but existence is a primary-key fact: the sweep must see through
    // the softDelete scope, or restoring the record would find its
    // attachments gone.
    expect(report.orphanRows).toEqual([])
    expect(await Attachment.where({ id: kept.id }).first()).not.toBeNull()
    expect(await storage.disk('media').exists(kept.path)).toBe(true)
  })

  test('should not mistake a zero-padded morph id for a missing record', async () => {
    // '01' in the morph column, integer key 1 in the table: the membership
    // test must normalize both sides, or a live record's attachment is
    // swept over a spelling difference.
    await Post.forceCreate({ id: 1, title: 'alive' })
    const kept = await Post.attach('01', 'cover', PNG_1X1)

    const report = await engine().pruneOrphans()

    expect(report.orphanRows).toEqual([])
    expect(await Attachment.where({ id: kept.id }).first()).not.toBeNull()
  })

  test('should sweep every orphan of a type larger than one lookup chunk', async () => {
    // 600 ids exceeds the 500-per-query chunk: the loop must page through
    // rather than issuing one unbounded IN (or skipping the whole type).
    await Post.forceCreate({ id: 1, title: 'alive' })
    const now = new Date()
    const rows = []
    for (let i = 0; i < 600; i++) {
      rows.push(`('u${i}', 'Post', '${i + 1000}', 'cover', 'media', 'attachments/u${i}/x.png', 'x.png', 'image/png', 1, ${now.getTime()}, ${now.getTime()})`)
    }
    sqlite.exec(
      `INSERT INTO attachments (id, attachable_type, attachable_id, collection, disk, path, name, content_type, size, created_at, updated_at) VALUES ${rows.join(',')}`,
    )
    const kept = await Post.attach(1, 'cover', PNG_1X1)

    const report = await engine().pruneOrphans()

    expect(report.orphanRows).toHaveLength(600)
    expect(report.skippedTypes).toEqual([])
    expect(await Attachment.where({ id: kept.id }).first()).not.toBeNull()
  })

  test('should see rows an app-added global scope on Attachment would hide', async () => {
    // configureAttachments() hands the Attachment model to the app, which
    // may scope it. The maintenance snapshot must stay unscoped, or
    // --objects sweeps prefixes whose rows the scope hid.
    await Post.forceCreate({ id: 1, title: 'alive' })
    const kept = await Post.attach(1, 'cover', PNG_1X1)
    ;(Attachment as unknown as { addGlobalScope(name: string, fn: unknown): void }).addGlobalScope(
      'tenant',
      (q: { where: (field: string, value: unknown) => unknown }) => q.where('collection', 'no-such-collection'),
    )

    const report = await engine().pruneOrphans({ objects: true })

    expect(report.orphanObjectPrefixes).toEqual([])
    expect(await storage.disk('media').exists(kept.path)).toBe(true)
  })

  test('should examine registered disks even when no row references them', async () => {
    // A crash after writing to a secondary disk but before the row insert
    // leaves a prefix no row (and no config entry) mentions — enumeration
    // through the storage manager is what still finds it.
    const { MemoryStorageDriver } = await import('../src/index')
    storage.registerDisk('archive', () => new MemoryStorageDriver({ url: 'https://archive.test' }))
    const staleId = staleUlid()
    await storage.disk('archive').put(`attachments/${staleId}/left.bin`, Buffer.from('x'))

    const report = await engine().pruneOrphans({ objects: true })

    expect(report.orphanObjectPrefixes).toEqual([{ disk: 'archive', prefix: `attachments/${staleId}` }])
    expect(await storage.disk('archive').exists(`attachments/${staleId}/left.bin`)).toBe(false)
  })

  test('should report what a dry run would remove without deleting', async () => {
    const orphan = await Post.attach(99, 'cover', PNG_1X1)

    const report = await engine().pruneOrphans({ dryRun: true })

    expect(report.orphanRows.map((row) => row.id)).toEqual([orphan.id])
    expect(await Attachment.where({ id: orphan.id }).first()).not.toBeNull()
    expect(await storage.disk('media').exists(orphan.path)).toBe(true)
  })

  test('should leave rows of a type missing from Model.morphMap untouched', async () => {
    Model.morphMap = {} // the app forgot to register Post
    const row = await Post.attach(99, 'cover', PNG_1X1)

    const report = await engine().pruneOrphans()

    expect(report.orphanRows).toEqual([])
    expect(report.skippedTypes).toHaveLength(1)
    expect(report.skippedTypes[0]!.reason).toContain('Model.morphMap')
    expect(await Attachment.where({ id: row.id }).first()).not.toBeNull()
  })

  test('should leave rows untouched when the existence query fails', async () => {
    // A record that cannot be checked is not a deleted one: an outage must
    // not become a mass deletion.
    class Broken extends Model {}
    Broken.withoutGlobalScopes = () => {
      throw new Error('database is down')
    }
    Object.defineProperty(Broken, 'name', { value: 'Post' })
    Model.morphMap = { Post: Broken }
    const row = await Post.attach(99, 'cover', PNG_1X1)

    const report = await engine().pruneOrphans()

    expect(report.orphanRows).toEqual([])
    expect(report.skippedTypes[0]!.reason).toContain('database is down')
    expect(await Attachment.where({ id: row.id }).first()).not.toBeNull()
  })

  test('should remove storage prefixes without a row only with objects', async () => {
    await Post.forceCreate({ id: 1, title: 'alive' })
    const kept = await Post.attach(1, 'cover', PNG_1X1)
    await storage.disk('media').put('attachments/01STRAYPREFIXFROMACRASH00/leftover.bin', Buffer.from('x'))

    const without = await engine().pruneOrphans()
    expect(without.orphanObjectPrefixes).toEqual([])
    expect(await storage.disk('media').exists('attachments/01STRAYPREFIXFROMACRASH00/leftover.bin')).toBe(true)

    const withObjects = await engine().pruneOrphans({ objects: true })
    expect(withObjects.orphanObjectPrefixes).toEqual([
      { disk: 'media', prefix: 'attachments/01STRAYPREFIXFROMACRASH00' },
    ])
    expect(await storage.disk('media').exists('attachments/01STRAYPREFIXFROMACRASH00/leftover.bin')).toBe(false)
    expect(await storage.disk('media').exists(kept.path)).toBe(true)
  })

  test('should leave a freshly minted rowless prefix alone (attach in flight)', async () => {
    // attach() writes the object before the row: a prefix without a row that
    // was minted moments ago is an attach in progress, not debris.
    const { ulid } = await import('../src/attachments/ulid')
    const freshId = ulid()
    await storage.disk('media').put(`attachments/${freshId}/inflight.png`, Buffer.from('x'))

    const report = await engine().pruneOrphans({ objects: true })

    expect(report.orphanObjectPrefixes).toEqual([])
    expect(await storage.disk('media').exists(`attachments/${freshId}/inflight.png`)).toBe(true)
  })

  test('should sweep a rowless prefix whose ULID is older than the grace window', async () => {
    const staleId = staleUlid()
    await storage.disk('media').put(`attachments/${staleId}/leftover.png`, Buffer.from('x'))

    const report = await engine().pruneOrphans({ objects: true })

    expect(report.orphanObjectPrefixes).toEqual([{ disk: 'media', prefix: `attachments/${staleId}` }])
    expect(await storage.disk('media').exists(`attachments/${staleId}/leftover.png`)).toBe(false)
  })

  test('should keep prefixes of rows whose deletion was skipped', async () => {
    // A row we could not verify still owns its objects — --objects must not
    // sweep the prefix out from under it.
    Model.morphMap = {}
    const unverified = await Post.attach(99, 'cover', PNG_1X1)

    const report = await engine().pruneOrphans({ objects: true })

    expect(report.orphanObjectPrefixes).toEqual([])
    expect(await storage.disk('media').exists(unverified.path)).toBe(true)
  })

  test('should run as a console command', async () => {
    await Post.attach(99, 'cover', PNG_1X1)

    const lines: string[] = []
    const fakeStream = {
      write: (chunk: string) => {
        lines.push(String(chunk))
        return true
      },
    } as unknown as NodeJS.WriteStream
    const command = new AttachmentsPruneCommand()
    command.setInput(['--dry-run'])
    command.setOutput(new Output({ colors: false, stdout: fakeStream, stderr: fakeStream }))

    await command.handle()

    const output = lines.join('\n')
    expect(output).toContain('1 orphaned row(s) would be removed')
    expect(output).toContain('Dry run: nothing was deleted.')
  })
})

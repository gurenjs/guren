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
    Broken.where = () => {
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
    expect(output).toContain('1 orphaned row(s) would remove')
    expect(output).toContain('Dry run: nothing was deleted.')
  })
})

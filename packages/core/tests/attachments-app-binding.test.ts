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
  createApp,
  defineModel,
  DrizzleAdapter,
  generateAppKey,
  hasOneAttached,
  registerAttachmentRoutes,
  resetDefaultApplication,
  StorageManager,
  type Application,
  type Container,
} from '../src/index'
import { setActiveAttachmentEngine } from '../src/attachments/engine'
import { ATTACHMENTS_DDL, attachmentsTable } from './attachments-table'
import { PNG_1X1 } from './image-sniff.test'

const posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
})

class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached({ image: 'require' }),
}) {}

function storageIn(root: string): StorageManager {
  return new StorageManager({
    default: 'vault',
    disks: { vault: { driver: 'local', root, url: '/storage' } },
  })
}

describe('configureAttachments({ app }) (RFC 0023 §4)', () => {
  let sqlite: Database
  let tmpDir: string
  let previousAppKey: string | undefined

  beforeEach(() => {
    previousAppKey = process.env.APP_KEY
    process.env.APP_KEY = generateAppKey()
    sqlite = new Database(':memory:')
    sqlite.exec(`
      ${ATTACHMENTS_DDL}
      CREATE TABLE posts (id integer primary key, title text not null);
    `)
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
    tmpDir = mkdtempSync(join(tmpdir(), 'guren-attachments-app-'))
    resetDefaultApplication()
  })

  afterEach(() => {
    sqlite.close()
    setActiveAttachmentEngine(null)
    resetDefaultApplication()
    rmSync(tmpDir, { recursive: true, force: true })
    if (previousAppKey === undefined) delete process.env.APP_KEY
    else process.env.APP_KEY = previousAppKey
  })

  function appWithStorage(): Application {
    const app = createApp({ routes: (router) => registerAttachmentRoutes(router) })
    app.container.instance('storage', storageIn(tmpDir))
    return app
  }

  test('binds the engine on the app and hands the storage factory that app\'s container', async () => {
    const app = appWithStorage()
    const seen: Container[] = []

    configureAttachments({
      table: attachmentsTable,
      storage: (container) => {
        seen.push(container)
        return container.make('storage')
      },
      disk: 'vault',
      processor: null,
      disks: { vault: 'private' },
      delivery: {},
      app,
    })
    await Post.attach(1, 'cover', new File([PNG_1X1], 'cover.png', { type: 'image/png' }))

    expect(app.container.has('attachments')).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((container) => container === app.container)).toBe(true)
  })

  test('hands the storage factory the default application\'s container without app', async () => {
    const app = appWithStorage()
    const seen: Container[] = []

    configureAttachments({
      table: attachmentsTable,
      storage: (container) => {
        seen.push(container)
        return container.make('storage')
      },
      disk: 'vault',
      processor: null,
      disks: { vault: 'private' },
    })
    await Post.attach(1, 'cover', new File([PNG_1X1], 'cover.png', { type: 'image/png' }))

    expect(app.container.has('attachments')).toBe(false)
    expect(seen.every((container) => container === app.container)).toBe(true)
  })

  test('serves the delivery route from the app\'s own engine, not the one configured last', async () => {
    const own = appWithStorage()
    configureAttachments({
      table: attachmentsTable,
      storage: (container) => container.make('storage'),
      disk: 'vault',
      processor: null,
      disks: { vault: 'private' },
      delivery: {},
      app: own,
    })
    await own.boot()
    await Post.attach(1, 'cover', new File([PNG_1X1], 'cover.png', { type: 'image/png' }))
    const url = await Post.attachmentUrl(1, 'cover')

    // A later configuration, for another app, replaces the active engine but
    // not the one bound on `own`.
    const other = createApp()
    other.container.instance('storage', storageIn(mkdtempSync(join(tmpdir(), 'guren-attachments-other-'))))
    configureAttachments({
      table: attachmentsTable,
      storage: (container) => container.make('storage'),
      disk: 'vault',
      processor: null,
      disks: { vault: 'private' },
      delivery: { prefix: '/elsewhere' },
      app: other,
    })

    const response = await own.fetch(new Request(new URL(url!, 'http://app.test')))

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(PNG_1X1))
  })
})

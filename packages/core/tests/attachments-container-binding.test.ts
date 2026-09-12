import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Attachable,
  AttachmentsPruneCommand,
  configureAttachments,
  createApp,
  defineModel,
  DrizzleAdapter,
  generateAppKey,
  BufferedOutput,
  GenerateVariantsJob,
  hasOneAttached,
  registerAttachmentRoutes,
  resetDefaultApplication,
  ServiceProvider,
  StorageManager,
  type AttachmentEngine,
  type Application,
  type Container,
  type ServiceProviderConstructor,
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

/** An engine stand-in that records which of the two resolutions reached it. */
function recordingEngine(calls: string[], label: string): AttachmentEngine {
  return {
    generateVariants: async () => {
      calls.push(`generateVariants:${label}`)
    },
    pruneOrphans: async () => {
      calls.push(`pruneOrphans:${label}`)
      return {
        scannedRows: 0,
        orphanRows: [],
        skippedTypes: [],
        orphanObjectPrefixes: [],
        skippedDisks: [],
      }
    },
  } as unknown as AttachmentEngine
}

/**
 * A container whose engine differs from the one every fallback reaches, so the
 * choice is visible. The binding must not sit on the *ambient* app, or
 * `resolveAttachmentEngine()` finds it too and the fallback path looks correct.
 */
function twoEngines(calls: string[]): Container {
  setActiveAttachmentEngine(recordingEngine(calls, 'active'))
  const app = createApp()
  app.container.instance('attachments', recordingEngine(calls, 'bound'))
  createApp()
  return app.container
}

/** The scaffolded `AttachmentsProvider`, over an engine the test configured. */
function providerFor(engine: AttachmentEngine): ServiceProviderConstructor {
  return class AttachmentsProvider extends ServiceProvider {
    register(): void {
      engine.bindTo(this.container)
    }
  }
}

describe('AttachmentEngine.bindTo() (RFC 0023 §4)', () => {
  let sqlite: Database
  let tmpDir: string
  let tmpRoots: string[]
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
    tmpRoots = []
    tmpDir = storageRoot()
    resetDefaultApplication()
  })

  afterEach(() => {
    sqlite.close()
    setActiveAttachmentEngine(null)
    resetDefaultApplication()
    for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
    if (previousAppKey === undefined) delete process.env.APP_KEY
    else process.env.APP_KEY = previousAppKey
  })

  function storageRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'guren-attachments-'))
    tmpRoots.push(root)
    return root
  }

  function appWith(root: string, providers: ServiceProviderConstructor[] = []): Application {
    const app = createApp({ routes: (router) => registerAttachmentRoutes(router), providers })
    app.container.instance('storage', storageIn(root))
    return app
  }

  function configure(seen?: Container[]): AttachmentEngine {
    return configureAttachments({
      table: attachmentsTable,
      storage: (container) => {
        seen?.push(container)
        return container.make('storage')
      },
      disk: 'vault',
      processor: null,
      disks: { vault: 'private' },
      delivery: {},
    }).engine
  }

  test('a provider binds the engine and hands the storage factory that app\'s container', async () => {
    const seen: Container[] = []
    const engine = configure(seen)
    const app = appWith(tmpDir, [providerFor(engine)])
    await app.boot()
    // Last construction wins the ambient slot, so a storage factory reading the
    // ambient container gets this app rather than the one that bound the engine.
    const later = appWith(storageRoot())

    await Post.attach(1, 'cover', new File([PNG_1X1], 'cover.png', { type: 'image/png' }))

    expect(app.container.has('attachments')).toBe(true)
    expect(later.container.has('attachments')).toBe(false)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((container) => container === app.container)).toBe(true)
  })

  test('hands the storage factory the default application\'s container until one binds it', async () => {
    const seen: Container[] = []
    configure(seen)
    const app = appWith(tmpDir)
    await app.boot()

    await Post.attach(1, 'cover', new File([PNG_1X1], 'cover.png', { type: 'image/png' }))

    expect(app.container.has('attachments')).toBe(false)
    expect(seen.every((container) => container === app.container)).toBe(true)
  })

  test('serves the delivery route from the app\'s own engine, not the one configured last', async () => {
    const own = appWith(tmpDir, [providerFor(configure())])
    await own.boot()
    await Post.attach(1, 'cover', new File([PNG_1X1], 'cover.png', { type: 'image/png' }))
    const url = await Post.attachmentUrl(1, 'cover')

    // A second app in the same process, wired exactly as the scaffold wires
    // one: its configure() call replaces the active engine, its provider binds
    // that engine on its own container only.
    const other = appWith(storageRoot(), [providerFor(configure())])
    await other.boot()

    const response = await own.fetch(new Request(new URL(url!, 'http://app.test')))

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(PNG_1X1))
  })
  test('the queued job resolves the engine from the container the worker handed it', async () => {
    const calls: string[] = []
    const job = new GenerateVariantsJob()
    job.setContainer(twoEngines(calls))

    await job.handle({ attachmentId: 'whatever' })

    expect(calls).toEqual(['generateVariants:bound'])
  })

  test('attachments:prune resolves the engine from the console kernel\'s container', async () => {
    const calls: string[] = []
    const command = new AttachmentsPruneCommand(twoEngines(calls))
    command.setInput(['--dry-run'])
    command.setOutput(new BufferedOutput())

    await command.handle()

    expect(calls).toEqual(['pruneOrphans:bound'])
  })
})

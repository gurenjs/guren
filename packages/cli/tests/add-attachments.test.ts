import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  API_ROUTES_FIXTURE,
  APP_FIXTURE,
  BLOG_ROUTES_FIXTURE,
  DEFAULT_ROUTES_FIXTURE,
  PG_SCHEMA_FIXTURE,
  SQLITE_SCHEMA_FIXTURE,
  createTempWorkspace,
  type TempWorkspace,
} from './helpers'
import { runBlueprint } from '../src/blueprints'
import { runCheck } from '../src/check'

/** The conventional web routes entry, seeded by the tests that need one mounted. */
const WEB_ROUTES = { file: 'routes/web.ts', source: DEFAULT_ROUTES_FIXTURE }

const CONSOLE_FIXTURE = `import { ConsoleKernel } from '@guren/core'
import app from './app'

export const kernel = new ConsoleKernel({ container: app.container })
kernel.registerMany([])
`

async function seedApp(
  schema: string,
  options: { console?: boolean; routes?: { file: string; source: string } } = {},
): Promise<void> {
  await mkdir('db', { recursive: true })
  await mkdir('src', { recursive: true })
  await writeFile('db/schema.ts', schema)
  await writeFile('src/app.ts', APP_FIXTURE)
  if (options.console !== false) {
    await writeFile('src/console.ts', CONSOLE_FIXTURE)
  }
  if (options.routes) {
    await mkdir('routes', { recursive: true })
    await writeFile(options.routes.file, options.routes.source)
  }
}

describe('guren add attachments', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-add-attachments-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('installs the full layer on a Postgres app', async () => {
    await seedApp(PG_SCHEMA_FIXTURE)

    await runBlueprint('attachments', {})

    const schema = await readFile(resolve('db/schema.ts'), 'utf8')
    expect(schema).toContain("export const attachments = pgTable('attachments'")
    expect(schema).toContain('withTimezone: true')
    expect(schema).toContain("import type { AttachmentVariantRecord } from '@guren/core'")
    // Builders arrive through the dialect barrel the schema already uses.
    expect(schema).toMatch(/import \{[^}]*jsonb[^}]*\} from '@guren\/orm\/drizzle\/pg'/)
    expect(schema).toMatch(/import \{[^}]*index[^}]*\} from '@guren\/orm\/drizzle\/pg'/)

    const config = await readFile(resolve('config/attachments.ts'), 'utf8')
    expect(config).toContain('configureAttachments({')
    expect(config).toContain("import { attachments } from '../db/schema'")

    expect(existsSync(resolve('app/Providers/AttachmentsProvider.ts'))).toBe(true)
    const appFile = await readFile(resolve('src/app.ts'), 'utf8')
    expect(appFile).toContain('AttachmentsProvider')

    const consoleFile = await readFile(resolve('src/console.ts'), 'utf8')
    expect(consoleFile).toContain("import { AttachmentsPruneCommand } from '@guren/core'")
    expect(consoleFile).toContain('registerMany([AttachmentsPruneCommand])')

    // The app had no StorageProvider, so the storage blueprint came along.
    expect(existsSync(resolve('app/Providers/StorageProvider.ts'))).toBe(true)
  })

  it('produces a config the attachments check accepts', async () => {
    await seedApp(PG_SCHEMA_FIXTURE, { routes: WEB_ROUTES })

    await runBlueprint('attachments', {})

    const report = await runCheck({ cwd: workspace.dir })
    const result = report.checks.find((c) => c.key.startsWith('attachments-config:'))
    expect(result).toBeDefined()
    expect(result!.status).toBe('pass')

    // The scaffold's own disk must satisfy the rule the scaffold's own
    // shape exists to establish — uploads outside the served tree.
    const publicDisk = report.checks.find((c) => c.key.startsWith('attachments-public-disk:'))
    expect(publicDisk?.status).toBe('pass')

    // Nothing the blueprint writes may leave a failing attachments check
    // behind in a freshly scaffolded app.
    expect(
      report.checks.filter((c) => c.key.startsWith('attachments-') && c.status === 'fail'),
    ).toEqual([])

    // That last assertion is deliberately *not* read as proof about the
    // delivery rule, which reports nothing here rather than 'pass': it loads
    // the app's route definitions, and this workspace is a bare temp
    // directory the test has chdir'd into, so the scaffolded routes file
    // cannot resolve its own `@guren/core` import. The rule catches that and
    // stays quiet by design. Its two halves are covered where they can
    // actually run — the call this blueprint writes, by the wiring tests
    // below, and the rule's own verdicts in attachments-check.test.ts, which
    // injects route definitions instead of loading them.
    expect(report.checks.find((c) => c.key === 'attachments-delivery')).toBeUndefined()
  })

  it('writes the sqlite table shape for a sqlite schema', async () => {
    await seedApp(SQLITE_SCHEMA_FIXTURE)

    await runBlueprint('attachments', {})

    const schema = await readFile(resolve('db/schema.ts'), 'utf8')
    expect(schema).toContain("export const attachments = sqliteTable('attachments'")
    expect(schema).toContain("text('variants', { mode: 'json' })")
    expect(schema).toContain("integer('created_at', { mode: 'timestamp_ms' })")
  })

  it('leaves a schema that already declares an attachments table unchanged', async () => {
    const withTable = `${PG_SCHEMA_FIXTURE}\nexport const attachments = pgTable('attachments', {\n  id: text('id').primaryKey(),\n})\n`
    await seedApp(withTable)

    await runBlueprint('attachments', {})

    const schema = await readFile(resolve('db/schema.ts'), 'utf8')
    expect(schema).toBe(withTable)
  })

  it('still installs when the app has no console entry', async () => {
    await seedApp(PG_SCHEMA_FIXTURE, { console: false })

    await runBlueprint('attachments', {})

    expect(existsSync(resolve('config/attachments.ts'))).toBe(true)
    expect(existsSync(resolve('src/console.ts'))).toBe(false)
  })

  it('keeps an existing StorageProvider instead of overwriting it', async () => {
    await seedApp(PG_SCHEMA_FIXTURE)
    await mkdir('app/Providers', { recursive: true })
    const custom = `export default class StorageProvider { register(): void {} }\n`
    await writeFile('app/Providers/StorageProvider.ts', custom)

    await runBlueprint('attachments', {})

    expect(await readFile(resolve('app/Providers/StorageProvider.ts'), 'utf8')).toBe(custom)
  })

  it('does not install a second storage manager over a custom binding', async () => {
    await seedApp(PG_SCHEMA_FIXTURE)
    await mkdir('app/Providers', { recursive: true })
    // Storage bound under an unconventional file name: the prerequisite must
    // judge by the binding, not by the conventional filename.
    await writeFile(
      'app/Providers/CloudStorageProvider.ts',
      `export default class CloudStorageProvider {
  register(): void {
    this.container.instance('storage', createCloudManager())
  }
}\n`,
    )

    await runBlueprint('attachments', {})

    expect(existsSync(resolve('app/Providers/StorageProvider.ts'))).toBe(false)
    expect(existsSync(resolve('config/attachments.ts'))).toBe(true)
  })

  it('repairs instead of throwing on a second run', async () => {
    await seedApp(PG_SCHEMA_FIXTURE)
    await runBlueprint('attachments', {})
    const schemaAfterFirst = await readFile(resolve('db/schema.ts'), 'utf8')

    await runBlueprint('attachments', {})

    expect(await readFile(resolve('db/schema.ts'), 'utf8')).toBe(schemaAfterFirst)
    const consoleFile = await readFile(resolve('src/console.ts'), 'utf8')
    // Registered and imported exactly once.
    expect(consoleFile.split('AttachmentsPruneCommand').length - 1).toBe(2)
  })

  it('treats any exported attachments binding as an existing table', async () => {
    const withSchemaTable = `${PG_SCHEMA_FIXTURE}\nconst media = pgSchema('media')\nexport const attachments = media.table('attachments', {})\n`
    await seedApp(withSchemaTable)

    await runBlueprint('attachments', {})

    const schema = await readFile(resolve('db/schema.ts'), 'utf8')
    expect(schema.split('export const attachments').length - 1).toBe(1)
  })
  // The scaffolded config makes every attachment URL point at this route, so
  // the blueprint mounting it is load-bearing (see checkAttachmentsDelivery).
  describe('delivery route wiring', () => {
    it('mounts registerAttachmentRoutes in the web routes entry', async () => {
      await seedApp(PG_SCHEMA_FIXTURE, { routes: WEB_ROUTES })

      await runBlueprint('attachments', {})

      const routes = await readFile(resolve('routes/web.ts'), 'utf8')
      expect(routes).toContain("import { registerAttachmentRoutes } from '@guren/core'")
      expect(routes).toContain('registerAttachmentRoutes(router)')
    })

    it('mounts it in routes/api.ts on an app that has no routes/web.ts', async () => {
      await seedApp(PG_SCHEMA_FIXTURE, { routes: { file: 'routes/api.ts', source: API_ROUTES_FIXTURE } })

      await runBlueprint('attachments', {})

      expect(existsSync(resolve('routes/web.ts'))).toBe(false)
      const routes = await readFile(resolve('routes/api.ts'), 'utf8')
      expect(routes).toContain('registerAttachmentRoutes(router)')
    })

    // The call takes the registrar's own parameter name, which the blog
    // template spells `baseRouter` — a patch hard-coding `router` would emit
    // a file that does not compile.
    it("passes the registrar's own router parameter", async () => {
      await seedApp(PG_SCHEMA_FIXTURE, { routes: { file: 'routes/web.ts', source: BLOG_ROUTES_FIXTURE } })

      await runBlueprint('attachments', {})

      const routes = await readFile(resolve('routes/web.ts'), 'utf8')
      expect(routes).toContain('registerAttachmentRoutes(baseRouter)')
    })

    it('does not add a second call on a re-run', async () => {
      await seedApp(PG_SCHEMA_FIXTURE, { routes: WEB_ROUTES })
      await runBlueprint('attachments', {})

      await runBlueprint('attachments', {})

      const routes = await readFile(resolve('routes/web.ts'), 'utf8')
      expect(routes.split('registerAttachmentRoutes').length - 1).toBe(2)
    })
  })
})

import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  APP_FIXTURE,
  PG_SCHEMA_FIXTURE,
  SQLITE_SCHEMA_FIXTURE,
  createTempWorkspace,
  type TempWorkspace,
} from './helpers'
import { runBlueprint } from '../src/blueprints'
import { runCheck } from '../src/check'

const CONSOLE_FIXTURE = `import { ConsoleKernel } from '@guren/core'
import app from './app'

export const kernel = new ConsoleKernel({ container: app.container })
kernel.registerMany([])
`

async function seedApp(schema: string, options: { console?: boolean } = {}): Promise<void> {
  await mkdir('db', { recursive: true })
  await mkdir('src', { recursive: true })
  await writeFile('db/schema.ts', schema)
  await writeFile('src/app.ts', APP_FIXTURE)
  if (options.console !== false) {
    await writeFile('src/console.ts', CONSOLE_FIXTURE)
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
    await seedApp(PG_SCHEMA_FIXTURE)

    await runBlueprint('attachments', {})

    const report = await runCheck({ cwd: workspace.dir })
    const result = report.checks.find((c) => c.key.startsWith('attachments-config:'))
    expect(result).toBeDefined()
    expect(result!.status).toBe('pass')
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
})

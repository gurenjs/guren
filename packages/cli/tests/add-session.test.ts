import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  APP_FIXTURE,
  MYSQL_SCHEMA_FIXTURE,
  PG_SCHEMA_FIXTURE,
  SQLITE_SCHEMA_FIXTURE,
  createTempWorkspace,
  type TempWorkspace,
} from './helpers'
import { runBlueprint } from '../src/blueprints'
import { appConfiguresSessions } from '../src/add-session'

const CONSOLE_FIXTURE = `import { ConsoleKernel } from '@guren/core'
import app from './app'

export const kernel = new ConsoleKernel({ container: app.container })
kernel.registerMany([])
`

async function seedApp(schema: string, options: { console?: boolean; env?: string } = {}): Promise<void> {
  await mkdir('db', { recursive: true })
  await mkdir('src', { recursive: true })
  await writeFile('db/schema.ts', schema)
  await writeFile('src/app.ts', APP_FIXTURE)
  if (options.console !== false) {
    await writeFile('src/console.ts', CONSOLE_FIXTURE)
  }
  if (options.env !== undefined) {
    await writeFile('.env.example', options.env)
  }
}

describe('guren add session', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-add-session-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('installs the schema table, config, provider, and prune command on a Postgres app', async () => {
    await seedApp(PG_SCHEMA_FIXTURE, { env: 'APP_KEY=\n' })

    await runBlueprint('session', {})

    const schema = await readFile(resolve('db/schema.ts'), 'utf8')
    expect(schema).toContain("export const sessions = pgTable('sessions'")
    expect(schema).toContain('withTimezone: true')
    expect(schema).toContain("index('sessions_expires_at_idx')")
    // Builders arrive through the dialect barrel the schema already uses.
    expect(schema).toMatch(/import \{[^}]*jsonb[^}]*\} from '@guren\/orm\/drizzle\/pg'/)

    const config = await readFile(resolve('config/session.ts'), 'utf8')
    expect(config).toContain("import { sessions } from '../db/schema'")
    expect(config).toContain("default: process.env.SESSION_DRIVER ?? 'database'")
    expect(config).toContain("database: { driver: 'database', table: sessions }")

    const provider = await readFile(resolve('app/Providers/SessionProvider.ts'), 'utf8')
    expect(provider).toContain("this.container.instance('session', createSessionManager(sessionConfig))")

    const app = await readFile(resolve('src/app.ts'), 'utf8')
    expect(app).toContain('SessionProvider')

    const console = await readFile(resolve('src/console.ts'), 'utf8')
    expect(console).toContain("import { SessionsPruneCommand } from '@guren/core'")
    expect(console).toContain('kernel.registerMany([SessionsPruneCommand])')

    const env = await readFile(resolve('.env.example'), 'utf8')
    expect(env).toContain('SESSION_DRIVER=database')
    expect(env).toContain('# SESSION_DRIVER=redis')
  })

  it('emits a timestamp_ms expiry on SQLite and a varchar id on MySQL', async () => {
    await seedApp(SQLITE_SCHEMA_FIXTURE)
    await runBlueprint('session', {})
    const sqlite = await readFile(resolve('db/schema.ts'), 'utf8')
    expect(sqlite).toContain("export const sessions = sqliteTable('sessions'")
    expect(sqlite).toContain("integer('expires_at', { mode: 'timestamp_ms' })")

    await workspace.cleanup()
    workspace = await createTempWorkspace('guren-cli-add-session-mysql-')
    await seedApp(MYSQL_SCHEMA_FIXTURE)
    await runBlueprint('session', {})
    const mysql = await readFile(resolve('db/schema.ts'), 'utf8')
    expect(mysql).toContain("export const sessions = mysqlTable('sessions'")
    expect(mysql).toContain("varchar('id', { length: 64 })")
  })

  it('leaves an existing sessions table and config alone on a re-run', async () => {
    await seedApp(`${PG_SCHEMA_FIXTURE}\nexport const sessions = pgTable('sessions', { id: text('id').primaryKey() })\n`)
    await writeFile(resolve('config/session.ts'), '// hand-written\n').catch(async () => {
      await mkdir('config', { recursive: true })
      await writeFile(resolve('config/session.ts'), '// hand-written\n')
    })

    await runBlueprint('session', {})

    const schema = await readFile(resolve('db/schema.ts'), 'utf8')
    expect(schema.match(/export const sessions =/g)).toHaveLength(1)
    expect(await readFile(resolve('config/session.ts'), 'utf8')).toBe('// hand-written\n')
  })

  it('reports the config it would need when there is no schema or console entry', async () => {
    await mkdir('src', { recursive: true })
    await writeFile('src/app.ts', APP_FIXTURE)

    await runBlueprint('session', {})

    // The scaffold still lands; only the patches that had no target are skipped.
    expect(await appConfiguresSessions()).toBe(true)
  })

  it('appends SESSION_DRIVER only when .env.example does not mention it', async () => {
    await seedApp(PG_SCHEMA_FIXTURE, { env: 'APP_KEY=\n# SESSION_DRIVER=redis\n' })

    await runBlueprint('session', {})

    const env = await readFile(resolve('.env.example'), 'utf8')
    expect(env.match(/SESSION_DRIVER/g)).toHaveLength(1)
  })
})

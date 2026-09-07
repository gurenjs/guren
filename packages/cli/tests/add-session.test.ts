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
import { addSession, appConfiguresSessions } from '../src/add-session'

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
    // Only as a comment: a real import puts ioredis in every bundle, including
    // one whose SESSION_DRIVER is `database`.
    expect(config).not.toMatch(/^import .*@guren\/core\/redis/m)
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
    expect(env).toContain('# SESSION_DRIVER=memory')
  })

  const dialects = [
    ['SQLite', SQLITE_SCHEMA_FIXTURE, "sqliteTable('sessions'", "integer('expires_at', { mode: 'timestamp_ms' })"],
    ['MySQL', MYSQL_SCHEMA_FIXTURE, "mysqlTable('sessions'", "varchar('id', { length: 64 })"],
  ] as const

  for (const [dialect, fixture, table, column] of dialects) {
    it(`emits ${dialect} column types`, async () => {
      await seedApp(fixture)

      await runBlueprint('session', {})

      const schema = await readFile(resolve('db/schema.ts'), 'utf8')
      expect(schema).toContain(`export const sessions = ${table}`)
      expect(schema).toContain(column)
    })
  }

  it('leaves an existing sessions table and config alone on a re-run', async () => {
    await seedApp(`${PG_SCHEMA_FIXTURE}\nexport const sessions = pgTable('sessions', { id: text('id').primaryKey() })\n`)
    await mkdir('config', { recursive: true })
    await writeFile(resolve('config/session.ts'), '// hand-written\n')

    await runBlueprint('session', {})

    const schema = await readFile(resolve('db/schema.ts'), 'utf8')
    expect(schema.match(/export const sessions =/g)).toHaveLength(1)
    expect(await readFile(resolve('config/session.ts'), 'utf8')).toBe('// hand-written\n')
  })

  it('writes nothing when there is no db/schema.ts to back the store', async () => {
    await mkdir('src', { recursive: true })
    await writeFile('src/app.ts', APP_FIXTURE)

    const result = await addSession({})

    // config/session.ts imports `sessions` from the schema, so writing it here
    // would ship an app that cannot compile.
    expect(result).toEqual({ files: [], schemaChanged: false })
    expect(await appConfiguresSessions()).toBe(false)
    expect(await readFile(resolve('src/app.ts'), 'utf8')).toBe(APP_FIXTURE)
  })

  it('leaves an app that already binds a session manager alone', async () => {
    await seedApp(PG_SCHEMA_FIXTURE)
    await mkdir('app/Providers', { recursive: true })
    await writeFile(
      'app/Providers/CustomSessionProvider.ts',
      "export default class CustomSessionProvider { register() { this.container.instance('session', {}) } }\n",
    )

    expect(await appConfiguresSessions()).toBe(true)
  })

  it('skips wiring but still writes files when the caller opts out', async () => {
    await seedApp(PG_SCHEMA_FIXTURE)

    const result = await addSession({ wire: false })

    expect(result.files).toHaveLength(2)
    expect(await readFile(resolve('src/app.ts'), 'utf8')).toBe(APP_FIXTURE)
    expect(await readFile(resolve('src/console.ts'), 'utf8')).not.toContain('SessionsPruneCommand')
  })

  it('appends SESSION_DRIVER only when the env file does not mention it', async () => {
    await seedApp(PG_SCHEMA_FIXTURE, { env: 'APP_KEY=\n# SESSION_DRIVER=redis\n' })

    await runBlueprint('session', {})

    const env = await readFile(resolve('.env.example'), 'utf8')
    expect(env.match(/SESSION_DRIVER/g)).toHaveLength(1)
  })

  it('writes SESSION_DRIVER into .env too, which is the file the app reads', async () => {
    await seedApp(PG_SCHEMA_FIXTURE, { env: 'APP_KEY=\n' })
    await writeFile('.env', 'APP_KEY=local\n')

    await runBlueprint('session', {})

    expect(await readFile(resolve('.env'), 'utf8')).toContain('SESSION_DRIVER=database')
    expect(await readFile(resolve('.env.example'), 'utf8')).toContain('SESSION_DRIVER=database')
  })
})

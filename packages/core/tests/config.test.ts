import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteDatabase } from '@guren/orm'
import { createApp, defineEnv, Env, resetDefaultApplication, ServiceProvider, type SessionManager } from '@guren/server'
import { defineDatabaseConfig, defineSessionConfig } from '../src/config'
import { createSessionManager } from '../src/session-manager'

afterEach(() => {
  resetDefaultApplication()
})

function recordingDatabase(received: unknown[]) {
  return createSqliteDatabase({
    migrationsFolder: '/nonexistent/rfc27-migrations',
    filename: (context) => {
      received.push(context)
      return ':memory:'
    },
  })
}

describe('defineDatabaseConfig() (RFC 0027 §2)', () => {
  test('connects at boot through the validated env, and seeds nothing without migrations', async () => {
    const received: unknown[] = []
    const database = recordingDatabase(received)
    // seedOnBoot with no seeders folder: seedDatabase() would throw, so a clean boot proves the skip.
    const app = createApp({
      env: defineEnv({ RFC27_DB_FILE: Env.string().default(':memory:') }),
      config: [defineDatabaseConfig(database, { seedOnBoot: true })],
    })

    try {
      await app.boot()

      expect(received).toEqual([{ env: { RFC27_DB_FILE: ':memory:' } }])
      expect(app.container.make('database')).toBe(database)
    } finally {
      await database.closeDatabase()
    }
  })

  test('passes no context without an env schema, so the resolver falls back on its own', async () => {
    const received: unknown[] = []
    const database = recordingDatabase(received)
    const app = createApp({ config: [defineDatabaseConfig(database)] })

    try {
      await app.boot()

      expect(received).toEqual([undefined])
    } finally {
      await database.closeDatabase()
    }
  })
})

describe('the built declaration', () => {
  // `defineSessionConfig`, `defineDatabaseConfig` and a typed `context.env` compile
  // in an app only if these augmentations survive into core's bundled .d.ts.
  test('carries the ConfigDefinitions and OrmConnectionEnv augmentations', () => {
    const declaration = join(import.meta.dir, '../dist/index.d.ts')
    if (!existsSync(declaration)) {
      throw new Error(`Expected ${declaration}; run \`bun run build core\` before this test.`)
    }

    const source = readFileSync(declaration, 'utf8')
    expect(source).toMatch(/interface ConfigDefinitions\s*\{\s*session: SessionConfig;?\s*database: DatabaseConfig;?\s*\}/)
    expect(source).toMatch(/declare module '@guren\/orm'\s*\{[^}]*interface OrmConnectionEnv extends AppEnv/)
  })
})

describe('defineSessionConfig() (RFC 0027 §2)', () => {
  test('binds a session manager that knows the database driver', async () => {
    const app = createApp({
      config: [defineSessionConfig(() => ({ default: 'database', stores: { database: { driver: 'database', table: {} } } }))],
    })

    await app.boot()

    expect(() => app.container.make<SessionManager>('session').assertDriverRegistered()).not.toThrow()
  })

  test('fails the boot when a SessionProvider binds session as well', async () => {
    class SessionProvider extends ServiceProvider {
      register(): void {
        this.container.instance('session', createSessionManager({}))
      }
    }
    const app = createApp({ config: [defineSessionConfig(() => ({}))], providers: [SessionProvider] })

    await expect(app.boot()).rejects.toThrow('"session" is configured twice: config/session.ts and SessionProvider.register()')
  })
})

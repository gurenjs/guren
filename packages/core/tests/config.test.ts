import { afterEach, describe, expect, test } from 'bun:test'
import { createSqliteDatabase } from '@guren/orm'
import { createApp, defineEnv, Env, resetDefaultApplication, ServiceProvider, type SessionManager } from '@guren/server'
import { defineDatabaseConfig, defineSessionConfig } from '../src/config'
import { createSessionManager } from '../src/session-manager'

describe('defineDatabaseConfig() (RFC 0027 §2)', () => {
  test('connects at boot through the validated env, and seeds nothing without migrations', async () => {
    const received: unknown[] = []
    const database = createSqliteDatabase({
      migrationsFolder: '/nonexistent/rfc27-migrations',
      filename: (context) => {
        received.push(context)
        return ':memory:'
      },
    })
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
})

afterEach(() => {
  resetDefaultApplication()
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

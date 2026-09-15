import { afterEach, describe, expect, test } from 'bun:test'
import { createApp, resetDefaultApplication, ServiceProvider, type SessionManager } from '@guren/server'
import { defineSessionConfig } from '../src/config'
import { createSessionManager } from '../src/session-manager'

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

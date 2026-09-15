import { afterEach, describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ServiceProvider, type ServiceProviderConstructor } from '../../src/container/ServiceProvider'
import { createApp } from '../../src/http/Application'
import { resetDefaultApplication } from '../../src/http/default-application'
import {
  BroadcastServiceProvider,
  CacheServiceProvider,
  EventServiceProvider,
  HealthServiceProvider,
  LogServiceProvider,
  MailServiceProvider,
  NotificationServiceProvider,
  OAuthServiceProvider,
  QueueServiceProvider,
  SchedulingServiceProvider,
  StorageServiceProvider,
} from '../../src/providers'

const PROVIDERS = join(import.meta.dir, '../../src/providers')

// Bindings a default provider may make without `singletonIf`: the config it
// validates, and the keyring behind its own `has()` guard.
const ALLOWED = new Set([
  "ConfigServiceProvider.ts: this.container.instance('env'",
  "EncryptionServiceProvider.ts: this.container.instance('app.keyring'",
])

afterEach(() => {
  resetDefaultApplication()
})

describe('framework default providers (RFC 0027 §3)', () => {
  test('bind only through singletonIf, so a provider listed later never replaces the app binding', async () => {
    const offenders: string[] = []

    for (const name of await readdir(PROVIDERS)) {
      if (!name.endsWith('.ts')) continue
      const source = await readFile(join(PROVIDERS, name), 'utf8')
      for (const match of source.matchAll(/this\.container\.(?:bind|singleton|instance)\s*(?:<[^>]*>)?\(\s*['"][^'"]*['"]?/g)) {
        const call = `${name}: ${match[0]}`
        if (!ALLOWED.has(call)) offenders.push(call)
      }
    }

    expect(offenders).toEqual([])
  })

  // The default's boot() calls these on whatever the key resolves to.
  const bootCalls: Record<string, object> = {
    events: { setQueueDispatcher() {} },
    notifications: { registerQueueJob() {} },
  }

  const cases: ReadonlyArray<readonly [string, ServiceProviderConstructor]> = [
    ['broadcast', BroadcastServiceProvider],
    ['cache', CacheServiceProvider],
    ['events', EventServiceProvider],
    ['health', HealthServiceProvider],
    ['log', LogServiceProvider],
    ['mail', MailServiceProvider],
    ['notifications', NotificationServiceProvider],
    ['oauth', OAuthServiceProvider],
    ['queue', QueueServiceProvider],
    ['scheduler', SchedulingServiceProvider],
    ['storage', StorageServiceProvider],
  ]

  test.each(cases)('keeps the app binding for "%s" when the default provider is listed after it', async (key, DefaultProvider) => {
    const own = { own: key, ...bootCalls[key] }
    class AppProvider extends ServiceProvider {
      register(): void {
        this.container.instance(key, own)
      }
    }
    const app = createApp({ providers: [AppProvider, DefaultProvider] })

    await app.boot()

    expect(app.container.make<object>(key)).toBe(own)
  })
})

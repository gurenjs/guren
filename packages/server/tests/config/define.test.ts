import { afterEach, describe, expect, test } from 'bun:test'
import { createGitHubOAuthProviderConfig, MemoryOAuthStateStore, type OAuthManager, type OAuthStatePayload } from '../../src/auth/oauth'
import {
  defineCacheConfig,
  defineConfig,
  defineHttpConfig,
  defineMailConfig,
  defineOAuthConfig,
  defineQueueConfig,
  defineStorageConfig,
} from '../../src/config/define'
import { defineEnv, Env } from '../../src/config/env'
import { defineModule } from '../../src/container/defineModule'
import { ServiceProvider } from '../../src/container/ServiceProvider'
import { createApp } from '../../src/http/Application'
import { resetDefaultApplication } from '../../src/http/default-application'
import { CacheServiceProvider } from '../../src/providers'

const log: string[] = []

function recordStored<T>(stateStore: MemoryOAuthStateStore, pick: (payload: OAuthStatePayload) => T): T[] {
  const recorded: T[] = []
  const store = stateStore.store.bind(stateStore)
  stateStore.store = async (hash, payload) => {
    recorded.push(pick(payload))
    await store(hash, payload)
  }
  return recorded
}

function sentinelCache(label: string) {
  const manager = { label }
  return defineConfig({
    key: 'cache',
    resolve: () => ({ default: 'memory' }),
    bind: (container) => {
      container.instance('cache', manager)
    },
    boot: () => {
      log.push(`boot ${label}`)
    },
  })
}

class ReadsCache extends ServiceProvider {
  register(): void {
    log.push(`register sees ${(this.container.make<{ label: string }>('cache')).label}`)
  }

  boot(): void {
    log.push('boot app provider')
  }
}

afterEach(() => {
  log.length = 0
  resetDefaultApplication()
})

describe('createApp({ config }) (RFC 0027 §2, §3)', () => {
  test('binds each definition before any app provider registers, and boots it first', async () => {
    const app = createApp({ config: [sentinelCache('configured')], providers: [ReadsCache] })

    await app.boot()

    expect(log).toEqual(['register sees configured', 'boot configured', 'boot app provider'])
  })

  test('resolves each definition against the validated env', async () => {
    let received: unknown
    const env = defineEnv({ RFC27_CACHE_STORE: Env.string().default('memory') })
    const app = createApp({
      env,
      config: [defineConfig({
        key: 'cache',
        resolve: (values) => {
          received = values
          return {}
        },
        bind: () => {},
      })],
    })

    await app.boot()

    expect(received).toEqual({ RFC27_CACHE_STORE: 'memory' })
  })

  test('resolves against an empty env when no schema is given', async () => {
    let received: unknown
    const app = createApp({
      config: [defineConfig({ key: 'cache', resolve: (values) => (received = values, {}), bind: () => {} })],
    })

    await app.boot()

    expect(received).toEqual({})
  })

  test('fails the boot when two definitions share a key', async () => {
    const app = createApp({ config: [sentinelCache('first'), sentinelCache('second')] })

    await expect(app.boot()).rejects.toThrow('"cache" has two config definitions, at createApp({ config })[0] and createApp({ config })[1]. Keep one.')
  })

  test('fails the boot when a later provider rebinds a configured key, naming both', async () => {
    class CacheProvider extends ServiceProvider {
      register(): void {
        this.container.instance('cache', { label: 'provider' })
      }
    }
    const app = createApp({ config: [sentinelCache('configured')], providers: [CacheProvider] })

    await expect(app.boot()).rejects.toThrow('"cache" is configured twice: config/cache.ts and CacheProvider.register(). Keep one.')
    await expect(app.boot()).rejects.toThrow('configured twice')
  })

  test('keeps the configured binding when a framework default provider is listed', async () => {
    const app = createApp({ config: [sentinelCache('configured')], providers: [CacheServiceProvider, ReadsCache] })

    await app.boot()

    expect(log[0]).toBe('register sees configured')
  })
})

describe('defineModule({ config }) (RFC 0002, RFC 0027 §2)', () => {
  test('binds a module definition when the app has no env and no config of its own', async () => {
    const app = createApp({
      modules: [defineModule({ name: 'billing', config: [sentinelCache('module')] })],
      providers: [ReadsCache],
    })
    await app.boot()

    expect(app.container.make<{ label: string }>('cache').label).toBe('module')
    expect(log).toEqual(['register sees module', 'boot module', 'boot app provider'])
  })

  test('boots createApp({ config }) first, then each module in modules order', async () => {
    const tagged = (label: string, key: 'mail' | 'queue' | 'storage') => defineConfig({
      key,
      resolve: () => ({}) as never,
      bind: () => {},
      boot: () => {
        log.push(`boot ${label}`)
      },
    })
    const app = createApp({
      config: [sentinelCache('root')],
      modules: [
        defineModule({ name: 'billing', config: [tagged('billing', 'mail')] }),
        defineModule({ name: 'shipping', config: [tagged('shipping', 'queue'), tagged('shipping', 'storage')] }),
      ],
    })
    await app.boot()

    expect(log).toEqual(['boot root', 'boot billing', 'boot shipping', 'boot shipping'])
  })

  test('fails the boot when the app and a module define one key, naming both', async () => {
    const app = createApp({
      config: [sentinelCache('root')],
      modules: [defineModule({ name: 'billing', config: [sentinelCache('module')] })],
    })

    await expect(app.boot()).rejects.toThrow('"cache" has two config definitions, at createApp({ config })[0] and the "billing" module\'s config[0]. Keep one.')
  })

  test('fails the boot when two modules define one key, naming both', async () => {
    const app = createApp({
      modules: [
        defineModule({ name: 'billing', config: [sentinelCache('billing')] }),
        defineModule({ name: 'shipping', config: [sentinelCache('shipping')] }),
      ],
    })

    await expect(app.boot()).rejects.toThrow('at the "billing" module\'s config[0] and the "shipping" module\'s config[0]')
  })

  test('fails the boot when a module provider rebinds a key a module definition configured', async () => {
    class CacheProvider extends ServiceProvider {
      register(): void {
        this.container.instance('cache', { label: 'provider' })
      }
    }
    const app = createApp({
      modules: [defineModule({ name: 'billing', config: [sentinelCache('module')], providers: [CacheProvider] })],
    })

    await expect(app.boot()).rejects.toThrow('"cache" is configured twice: config/cache.ts of the "billing" module and CacheProvider.register(). Keep one.')
  })

  test('fails the boot when a module provider rebinds a key createApp({ config }) configured', async () => {
    class CacheProvider extends ServiceProvider {
      register(): void {
        this.container.instance('cache', { label: 'provider' })
      }
    }
    const app = createApp({
      config: [sentinelCache('root')],
      modules: [defineModule({ name: 'billing', providers: [CacheProvider] })],
    })

    await expect(app.boot()).rejects.toThrow('"cache" is configured twice: config/cache.ts and CacheProvider.register(). Keep one.')
  })

  test('accepts a module literal built without defineModule() and with no config', async () => {
    const app = createApp({ modules: [{ name: 'billing', providers: [], commands: [] }] })

    await expect(app.boot()).resolves.toBeUndefined()
  })
})

describe('the per-concern helpers', () => {
  test('bind the manager each concern names', async () => {
    const app = createApp({
      config: [
        defineCacheConfig(() => ({ default: 'memory' })),
        defineMailConfig(() => ({ default: 'log', transports: { log: { driver: 'log' } } })),
        defineQueueConfig(() => ({})),
        defineStorageConfig(() => ({})),
      ],
    })

    await app.boot()

    for (const key of ['cache', 'mail', 'queue', 'storage']) {
      expect(app.container.make<object>(key)).toBeInstanceOf(Object)
    }
  })

  test('defineOAuthConfig registers each provider entry', async () => {
    const github = createGitHubOAuthProviderConfig({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost/callback' })
    const app = createApp({ config: [defineOAuthConfig(() => ({ providers: { github } }))] })

    await app.boot()

    expect(app.container.make<OAuthManager>('oauth').providerNames()).toEqual(['github'])
  })

  test('defineOAuthConfig keeps authorize states in the stateStore it names', async () => {
    const github = createGitHubOAuthProviderConfig({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost/callback' })
    const stateStore = new MemoryOAuthStateStore()
    const stored = recordStored(stateStore, (payload) => payload.provider)
    const app = createApp({ config: [defineOAuthConfig(() => ({ providers: { github }, stateStore }))] })

    await app.boot()
    await app.container.make<OAuthManager>('oauth').authorize('github')

    expect(stored).toEqual(['github'])
  })

  test('defineOAuthConfig passes its stateConfig allowlist to the manager', async () => {
    const github = createGitHubOAuthProviderConfig({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost/callback' })
    const stateStore = new MemoryOAuthStateStore()
    const redirects = recordStored(stateStore, (payload) => payload.redirectTo)
    const app = createApp({
      config: [defineOAuthConfig(() => ({
        providers: { github },
        stateStore,
        stateConfig: { allowedRedirectHosts: ['app.example.com'] },
      }))],
    })

    await app.boot()
    const oauth = app.container.make<OAuthManager>('oauth')
    await oauth.authorize('github', { redirectTo: 'https://app.example.com/welcome', bindTo: 'test' })
    await oauth.authorize('github', { redirectTo: 'https://evil.example.net/', bindTo: 'test' })

    expect(redirects).toEqual(['https://app.example.com/welcome', undefined])
  })
})

describe('defineHttpConfig() host authorization (RFC 0027 §5)', () => {
  function httpApp(hostAuthorization: Parameters<typeof defineHttpConfig>[0]) {
    return createApp({
      config: [defineHttpConfig(hostAuthorization)],
      boot: (hono) => {
        hono.get('/ping', (ctx) => ctx.text('pong'))
      },
    })
  }

  test('refuses a request that arrives before boot', async () => {
    const app = httpApp(() => ({ hostAuthorization: { allowedHosts: ['good.example'] } }))

    expect((await app.fetch(new Request('http://good.example/ping'))).status).toBe(503)
  })

  test('authorizes hosts from the resolved config once booted', async () => {
    const app = httpApp(() => ({ hostAuthorization: { allowedHosts: ['good.example'] } }))

    await app.boot()

    expect((await app.fetch(new Request('http://good.example/ping'))).status).toBe(200)
    expect((await app.fetch(new Request('http://evil.example/ping'))).status).toBe(403)
  })

  test('passes every host when the config disables it', async () => {
    const app = httpApp(() => ({ hostAuthorization: false }))

    await app.boot()

    expect((await app.fetch(new Request('http://evil.example/ping'))).status).toBe(200)
  })

  test('fails the boot when createApp({ hostAuthorization }) is also given', async () => {
    const app = createApp({
      hostAuthorization: { allowedHosts: ['good.example'] },
      config: [defineHttpConfig(() => ({ hostAuthorization: false }))],
    })

    await expect(app.boot()).rejects.toThrow('Host authorization is configured twice')
  })

  test('fails the boot when a module carries the http definition and createApp({ hostAuthorization }) is given', async () => {
    const app = createApp({
      hostAuthorization: { allowedHosts: ['good.example'] },
      modules: [defineModule({ name: 'edge', config: [defineHttpConfig(() => ({ hostAuthorization: false }))] })],
    })

    await expect(app.boot()).rejects.toThrow('Host authorization is configured twice')
  })
})

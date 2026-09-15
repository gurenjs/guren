import { afterEach, describe, expect, test } from 'bun:test'
import { createGitHubOAuthProviderConfig, type OAuthManager } from '../../src/auth/oauth'
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
import { ServiceProvider } from '../../src/container/ServiceProvider'
import { createApp } from '../../src/http/Application'
import { resetDefaultApplication } from '../../src/http/default-application'
import { CacheServiceProvider } from '../../src/providers'

const log: string[] = []

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

    await expect(app.boot()).rejects.toThrow('two "cache" definitions, at config[0] and config[1]')
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
})

import { describe, expect, it } from 'bun:test'
import { createApp, defineEnv, Env, type AppEnv, type CacheManager } from '@guren/core'
import { loadConfigTemplate } from './helpers'

const cacheConfig = await loadConfigTemplate('cache')

function appSelecting(store: string) {
  const app = createApp({ env: defineEnv({ CACHE_STORE: Env.string().default('memory') }), config: [cacheConfig] })
  app.container.instance('env.source', { CACHE_STORE: store })
  return app
}

// The template itself: scaffold-output.test.ts pins the written file byte-identical to it.
describe('scaffolded cache config definition', () => {
  it('boots with the store CACHE_STORE names', async () => {
    const app = appSelecting('memory')

    await app.boot()

    const cache = app.container.make<CacheManager>('cache')
    expect(cache.getDefaultStoreName()).toBe('memory')
    await cache.store().set('key', 'value')
    expect(await cache.store().get<string>('key')).toBe('value')
  })

  // The manager itself accepts any name and throws only on the first cache call.
  it('fails the boot on a CACHE_STORE it does not declare', async () => {
    await expect(appSelecting('redis').boot()).rejects.toThrow('CACHE_STORE="redis" is not a declared store')
  })

  it('refuses an undeclared CACHE_STORE at resolve', () => {
    expect(() => cacheConfig.resolve({ CACHE_STORE: 'redis' } as AppEnv)).toThrow('CACHE_STORE="redis" is not a declared store. Declare it in config/cache.ts or use one of: memory.')
  })
})

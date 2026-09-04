import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Application } from '../../src'
import { configureInertiaAssets } from '../../src/http/inertia-assets'
import { registerDevAssets } from '../../src/runtime'
import { useAssetFixture } from './asset-fixture'

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * Cache-Control on the `/public/*` static route. Only Vite's content-hashed
 * `public/assets/` files may be cached immutably in production; everything else
 * in public/ keeps stable names, and dev must never cache.
 */
describe('public asset cache headers', () => {
  const fixture = useAssetFixture('guren-public-cache-')
  const originalEnv = { ...process.env }

  beforeEach(async () => {
    process.env = { ...originalEnv }

    await fixture.write('public/assets/app-4f2b1c8d.js', 'console.log("hashed")\n')
    await fixture.write('public/assets/app-4f2b1c8d.css', 'body {}\n')
    await fixture.write('public/robots.txt', 'User-agent: *\n')
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  function createProductionApp(publicRoute?: string): Application {
    process.env.NODE_ENV = 'production'

    const app = new Application()
    configureInertiaAssets(app, {
      publicDir: fixture.path('public'),
      publicRoute,
      inertiaClient: false,
    })

    return app
  }

  it('serves hashed build assets with an immutable Cache-Control in production', async () => {
    const app = createProductionApp()

    const response = await app.fetch(new Request('http://example.com/public/assets/app-4f2b1c8d.js'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('hashed')
    expect(response.headers.get('Cache-Control')).toBe(IMMUTABLE_CACHE_CONTROL)
  })

  it('covers stylesheets under the hashed assets directory', async () => {
    const app = createProductionApp()

    const response = await app.fetch(new Request('http://example.com/public/assets/app-4f2b1c8d.css'))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe(IMMUTABLE_CACHE_CONTROL)
  })

  it('leaves files outside assets/ without a Cache-Control header in production', async () => {
    const app = createProductionApp()

    const response = await app.fetch(new Request('http://example.com/public/robots.txt'))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBeNull()
  })

  it('derives the hashed assets prefix from a custom public route', async () => {
    const app = createProductionApp('/static/*')

    const hashed = await app.fetch(new Request('http://example.com/static/assets/app-4f2b1c8d.js'))
    const stable = await app.fetch(new Request('http://example.com/static/robots.txt'))

    expect(hashed.status).toBe(200)
    expect(hashed.headers.get('Cache-Control')).toBe(IMMUTABLE_CACHE_CONTROL)
    expect(stable.status).toBe(200)
    expect(stable.headers.get('Cache-Control')).toBeNull()
  })

  it('never caches public assets on the dev route', async () => {
    await fixture.mkdir('resources')

    const app = new Application()
    registerDevAssets(app, {
      resourcesDir: fixture.path('resources'),
      publicDir: fixture.path('public'),
      inertiaClient: false,
    })

    const response = await app.fetch(new Request('http://example.com/public/assets/app-4f2b1c8d.js'))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBeNull()
  })
})

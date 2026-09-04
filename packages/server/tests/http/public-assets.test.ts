import { beforeEach, describe, expect, it } from 'bun:test'
import { Application } from '../../src'
import { DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS, registerRootPublicAssets } from '../../src/http/public-assets'
import { useAssetFixture } from './asset-fixture'

// Real files rather than a stubbed `Bun.file`: containment is a filesystem
// property, so a mocked reader would pass every case regardless of the middleware.
describe('registerRootPublicAssets', () => {
  const fixture = useAssetFixture('guren-public-assets-')
  let app: Application

  beforeEach(async () => {
    await fixture.write('public/readme.txt', 'public readme\n')
    await fixture.write('public/nested/notes.txt', 'nested notes\n')
    await fixture.write('outside/secret.txt', 'secret\n')

    fixture.symlink('outside', 'public/leak')
    fixture.symlink('outside/secret.txt', 'public/linked.txt')

    app = new Application()
    registerRootPublicAssets(app, fixture.path('public'), { extensions: ['txt'] })
  })

  it('serves matching assets from the public directory', async () => {
    const response = await app.fetch(new Request('http://example.com/readme.txt'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('public readme')
    expect(response.headers.get('Cache-Control')).toContain('max-age')
    expect(response.headers.get('Content-Type')).toContain('text/plain')
  })

  it('serves matching assets from nested directories', async () => {
    const response = await app.fetch(new Request('http://example.com/nested/notes.txt'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('nested notes')
  })

  it('falls through for extensions outside the allowlist', async () => {
    const response = await app.fetch(new Request('http://example.com/readme.md'))

    expect(response.status).toBe(404)
  })

  it('falls through for requests escaping the public directory', async () => {
    const response = await app.fetch(new Request(`http://example.com/${fixture.root}/outside/secret.txt`))

    expect(response.status).toBe(404)
  })

  it('falls through for a directory symlink leading out of the public directory', async () => {
    const response = await app.fetch(new Request('http://example.com/leak/secret.txt'))

    expect(response.status).toBe(404)
  })

  it('falls through for a file symlink leading out of the public directory', async () => {
    const response = await app.fetch(new Request('http://example.com/linked.txt'))

    expect(response.status).toBe(404)
  })
})

describe('registerRootPublicAssets with a route prefix', () => {
  const fixture = useAssetFixture('guren-public-assets-prefix-')
  let app: Application

  beforeEach(async () => {
    await fixture.write('public/assets/readme.txt', 'prefixed readme\n')

    app = new Application()
    registerRootPublicAssets(app, fixture.path('public'), { extensions: ['txt'], routePrefix: '/assets' })
  })

  it('serves assets under the configured prefix', async () => {
    const response = await app.fetch(new Request('http://example.com/assets/readme.txt'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('prefixed readme')
  })

  it('skips routes outside the configured prefix', async () => {
    const response = await app.fetch(new Request('http://example.com/static/readme.txt'))

    expect(response.status).toBe(404)
  })
})

describe('registerRootPublicAssets serving opt-in script and style assets', () => {
  const fixture = useAssetFixture('guren-public-assets-scripts-')
  let app: Application

  beforeEach(async () => {
    await fixture.write('public/vendor/lib.js', 'export const a = 1\n')
    await fixture.write('public/vendor/theme.css', 'body { color: red }\n')

    app = new Application()
    // `.js`/`.css` are not in the default allowlist; an app that opts in
    // should not also have to restate their content types.
    registerRootPublicAssets(app, fixture.path('public'), { extensions: ['js', 'css'] })
  })

  it('serves scripts as executable JavaScript', async () => {
    const response = await app.fetch(new Request('http://example.com/vendor/lib.js'))

    expect(response.status).toBe(200)
    // application/octet-stream here means the browser refuses to run it.
    expect(response.headers.get('Content-Type')).toContain('text/javascript')
  })

  it('serves stylesheets as text/css', async () => {
    const response = await app.fetch(new Request('http://example.com/vendor/theme.css'))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/css')
  })
})

describe('registerRootPublicAssets with a public directory reached through a symlink', () => {
  const fixture = useAssetFixture('guren-public-assets-linked-')
  let app: Application

  beforeEach(async () => {
    await fixture.write('real/public/readme.txt', 'linked readme\n')
    fixture.symlink('real/public', 'public-link')

    app = new Application()
    registerRootPublicAssets(app, fixture.path('public-link'), { extensions: ['txt'] })
  })

  it('serves assets through the symlinked public directory', async () => {
    const response = await app.fetch(new Request('http://example.com/readme.txt'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('linked readme')
  })
})

// `extensions` replaces the default list, so an app adding one extension used
// to restate the defaults and drift from them. The export exists so it can
// spread instead — these pin the export to what the middleware actually serves.
describe('DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS', () => {
  const fixture = useAssetFixture('guren-public-assets-defaults-')

  it('is the list served when extensions is omitted', async () => {
    await fixture.write('public/readme.txt', 'default txt\n')
    await fixture.write('public/script.js', 'console.log(1)\n')
    const app = new Application()
    registerRootPublicAssets(app, fixture.path('public'), {})

    expect(DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS).toContain('.txt')
    expect(DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS).not.toContain('.js')
    expect((await app.fetch(new Request('http://example.com/readme.txt'))).status).toBe(200)
    expect((await app.fetch(new Request('http://example.com/script.js'))).status).toBe(404)
  })

  it('spreads into extensions so an app extends the defaults instead of replacing them', async () => {
    await fixture.write('public/readme.txt', 'default txt\n')
    await fixture.write('public/script.js', 'console.log(1)\n')
    const app = new Application()
    registerRootPublicAssets(app, fixture.path('public'), {
      extensions: [...DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS, '.js'],
    })

    expect((await app.fetch(new Request('http://example.com/readme.txt'))).status).toBe(200)
    const script = await app.fetch(new Request('http://example.com/script.js'))
    expect(script.status).toBe(200)
    expect(script.headers.get('Content-Type')).toContain('text/javascript')
  })
})

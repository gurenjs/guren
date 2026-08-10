import { beforeEach, describe, expect, it } from 'bun:test'
import { Application } from '../../src'
import { registerBuiltInertiaClient } from '../../src/http/inertia-assets'
import { useAssetFixture } from './asset-fixture'

// Registered directly rather than through `configureInertiaAssets`, whose
// client directory comes from `import.meta.resolve` and cannot reach a fixture.
describe('registerBuiltInertiaClient', () => {
  const fixture = useAssetFixture('guren-inertia-client-')
  let app: Application

  beforeEach(async () => {
    await fixture.write('client/app.js', 'export const booted = true\n')
    await fixture.write('client/chunk-abc.js', 'export const chunkValue = 42\n')
    await fixture.write('outside/secret.js', "export const secret = 'leaked'\n")

    // Sibling directory whose name merely extends the client's own.
    await fixture.write('client-secrets/secret.js', "export const secret = 'leaked'\n")

    fixture.symlink('outside', 'client/leak')
    fixture.symlink('outside/secret.js', 'client/linked.js')

    app = new Application()
    registerBuiltInertiaClient(app, fixture.path('client'), '/vendor/inertia-client.tsx')
  })

  it('serves the built client entry', async () => {
    const response = await app.fetch(new Request('http://example.com/vendor/inertia-client.tsx'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('export const booted = true')
  })

  it('serves sibling chunks the client imports', async () => {
    const response = await app.fetch(new Request('http://example.com/vendor/chunk-abc.js'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('export const chunkValue = 42')
  })

  it('returns 404 for requests escaping the client directory', async () => {
    const response = await app.fetch(new Request('http://example.com/vendor/../app.js'))

    expect(response.status).toBe(404)
  })

  it('returns 404 for a sibling directory whose name extends the client directory', async () => {
    // The doubled slash leaves the remainder after `/vendor/` absolute, so it
    // survives `resolve()` untouched and lands next to — not inside — the
    // client directory.
    const response = await app.fetch(
      new Request(`http://example.com/vendor/${fixture.root}/client-secrets/secret.js`),
    )

    expect(response.status).toBe(404)
  })

  it('returns 404 for a directory symlink leading out of the client directory', async () => {
    const response = await app.fetch(new Request('http://example.com/vendor/leak/secret.js'))

    expect(response.status).toBe(404)
  })

  it('returns 404 for a file symlink leading out of the client directory', async () => {
    const response = await app.fetch(new Request('http://example.com/vendor/linked.js'))

    expect(response.status).toBe(404)
  })
})

describe('registerBuiltInertiaClient with a client directory reached through a symlink', () => {
  const fixture = useAssetFixture('guren-inertia-client-linked-')
  let app: Application

  beforeEach(async () => {
    await fixture.write('real/client/app.js', 'export const booted = true\n')
    await fixture.write('real/client/chunk-abc.js', 'export const chunkValue = 42\n')

    // The shape a published-package install produces: `node_modules/@guren/…`
    // is a link into another tree.
    fixture.symlink('real/client', 'client-link')

    app = new Application()
    registerBuiltInertiaClient(app, fixture.path('client-link'), '/vendor/inertia-client.tsx')
  })

  it('serves the entry through the symlinked client directory', async () => {
    const response = await app.fetch(new Request('http://example.com/vendor/inertia-client.tsx'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('export const booted = true')
  })

  it('serves chunks through the symlinked client directory', async () => {
    const response = await app.fetch(new Request('http://example.com/vendor/chunk-abc.js'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('export const chunkValue = 42')
  })
})

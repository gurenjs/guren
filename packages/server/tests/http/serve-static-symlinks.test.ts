import { beforeEach, describe, expect, it } from 'bun:test'
import { Application } from '../../src'
import { registerDevAssets } from '../../src/runtime'
import { useAssetFixture } from './asset-fixture'

/**
 * Guren's own asset handlers reject a target whose real location is outside the
 * configured root. `/public/*` and `/resources/css/*` are delegated to Hono's
 * `serveStatic`, which follows symlinks out of its root by design (as nginx and
 * `express.static` do), so only what Guren controls is asserted; the delegated
 * routes are pinned in neither direction (a deployment needing containment should not rely on `/public/*`).
 */
describe('symlink containment across the asset routes', () => {
  const fixture = useAssetFixture('guren-static-symlink-')
  let app: Application

  beforeEach(async () => {
    await fixture.mkdir('resources/css')
    await fixture.mkdir('public')
    await fixture.write('outside/secret.txt', 'leaked\n')
    await fixture.write('outside/secret.css', '/* leaked */\n')

    // One directory outside every root, linked into the public and css roots.
    fixture.symlink('outside', 'public/leak')
    fixture.symlink('outside', 'resources/css/leak')

    app = new Application()
    registerDevAssets(app, {
      resourcesDir: fixture.path('resources'),
      publicDir: fixture.path('public'),
      inertiaClient: false,
    })
  })

  it('refuses a symlink out of the public root on the framework-served root route', async () => {
    const response = await app.fetch(new Request('http://example.com/leak/secret.txt'))

    expect(response.status).toBe(404)
  })

  // These assert the property (no outside content served), not a mechanism: Hono
  // rejects the doubled separator before joining, so lexical escape is structurally
  // unavailable and the symlink case is the one that gets through.
  it('serves nothing from outside the root for an absolute-path request under /public/*', async () => {
    const response = await app.fetch(new Request(`http://example.com/public/${fixture.root}/outside/secret.txt`))

    expect(response.status).toBe(404)
  })

  it('serves nothing from outside the root for an absolute-path request under /resources/css/*', async () => {
    const response = await app.fetch(
      new Request(`http://example.com/resources/css/${fixture.root}/outside/secret.css`),
    )

    expect(response.status).toBe(404)
  })
})

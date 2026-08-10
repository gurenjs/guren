import { beforeEach, describe, expect, it } from 'bun:test'
import { Application } from '../../src'
import { registerDevAssets } from '../../src/runtime'
import { useAssetFixture } from './asset-fixture'

/**
 * Pins the containment the framework itself enforces, on routes that sit beside
 * ones it does not.
 *
 * Guren's own asset handlers — the dev transpiler, both Inertia client routes,
 * and the root-level public asset middleware — reject a target whose real
 * location is outside the configured root. `/public/*` and `/resources/css/*`
 * are not Guren handlers: they are delegated to Hono's `serveStatic`, whose path
 * handling makes lexical escape unavailable but which follows symlinks out of
 * its root by design, as nginx and `express.static` do.
 *
 * So the assertions below are deliberately asymmetric. What Guren controls is
 * asserted; the symlink behaviour of the delegated routes is not, in either
 * direction — asserting the current leak would commit the suite to it and turn
 * red if Hono ever tightens. Deployments that must not follow symlinks out of
 * `public/` should not rely on `/public/*` for that.
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

  // The two below assert the property (no outside content served), not a
  // mechanism: Hono rejects the doubled separator before joining, and its
  // `defaultJoin` would treat the remainder as relative anyway rather than
  // honouring it as absolute. Lexical escape is structurally unavailable there,
  // which is why the symlink case is the one that gets through.
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

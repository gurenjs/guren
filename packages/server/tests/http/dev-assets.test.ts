import { beforeEach, describe, expect, it } from 'bun:test'
import { Application } from '../../src'
import { registerDevAssets } from '../../src/runtime'
import { useAssetFixture } from './asset-fixture'

describe('registerDevAssets inertia client chunk handling', () => {
  const fixture = useAssetFixture('guren-dev-assets-')
  let app: Application

  beforeEach(async () => {
    // minimal resources directory so the helper can mount the transpiler route
    await fixture.write('resources/js/app.tsx', "export const noop = () => 'noop'\n")
    await fixture.write('resources/css/app.css', 'body { background: red; }\n')

    const inertiaEntry = await fixture.write(
      'inertia/inertia-client.tsx',
      [
        "export const startInertiaClient = () => 'booted'\n",
        "export { chunkValue } from './chunk-helper.ts'\n",
      ].join(''),
    )

    await fixture.write('inertia/chunk-helper.ts', "export const chunkValue = 42\n")

    // Sibling directory whose name extends the inertia client's own.
    await fixture.write('inertia-secrets/secret.ts', "export const secret = 'leaked'\n")

    // A directory outside both served roots, linked into each of them: `resolve()`
    // leaves the request path under the root, and only the reader follows it out.
    await fixture.write('outside/secret.ts', "export const secret = 'leaked'\n")
    await fixture.write('outside/secret.txt', 'leaked\n')
    fixture.symlink('outside', 'inertia/leak')
    fixture.symlink('outside', 'resources/js/leak')

    app = new Application()
    registerDevAssets(app, {
      resourcesDir: fixture.path('resources'),
      inertiaClientSource: inertiaEntry,
      inertiaClientPath: '/vendor/inertia-client.tsx',
      inertiaClient: true,
      publicPath: false,
    })
  })

  it('serves the configured inertia client entry file', async () => {
    const response = await app.fetch(new Request('http://example.com/vendor/inertia-client.tsx'))

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("export const startInertiaClient")
    expect(body).toContain('"booted"')
    expect(body).toContain("chunk-helper.ts")
  })

  it('serves sibling chunk files referenced by the inertia client', async () => {
    const response = await app.fetch(new Request('http://example.com/vendor/chunk-helper.ts'))

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('export const chunkValue = 42')
  })

  it('returns 404 for requests escaping the inertia client directory', async () => {
    const response = await app.fetch(new Request('http://example.com/vendor/../inertia-client.tsx'))

    expect(response.status).toBe(404)
  })

  it('returns 404 for a sibling directory whose name extends the inertia client directory', async () => {
    // The doubled slash leaves the remainder after `/vendor/` absolute, so it
    // survives `resolve()` untouched and lands next to — not inside — the
    // inertia client directory.
    const response = await app.fetch(
      new Request(`http://example.com/vendor/${fixture.root}/inertia-secrets/secret.ts`),
    )

    expect(response.status).toBe(404)
  })

  it('returns 404 for a symlink leading out of the inertia client directory', async () => {
    const response = await app.fetch(new Request('http://example.com/vendor/leak/secret.ts'))

    expect(response.status).toBe(404)
  })

  it('transpiles files from the resources directory', async () => {
    const response = await app.fetch(new Request('http://example.com/resources/js/app.tsx'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('noop')
  })

  it('returns 404 for requests escaping the resources directory', async () => {
    const response = await app.fetch(new Request(`http://example.com/resources/js/${fixture.root}/outside/secret.ts`))

    expect(response.status).toBe(404)
  })

  it('returns 404 for a symlink leading out of the resources directory', async () => {
    const response = await app.fetch(new Request('http://example.com/resources/js/leak/secret.ts'))

    expect(response.status).toBe(404)
  })

  it('returns 404 for a non-transpiled file reached through a symlink out of the resources directory', async () => {
    // A `.txt` target takes the static-serving branch rather than the transpiler,
    // and containment is judged before that fork — so both branches are covered.
    const response = await app.fetch(new Request('http://example.com/resources/js/leak/secret.txt'))

    expect(response.status).toBe(404)
  })

  it('returns 404 for an extensionless request resolving through a symlink out of the resources directory', async () => {
    // The extension probing that turns `secret` into `secret.ts` is what settles
    // which file is read, so containment has to be judged after it — not on the
    // extensionless path the request supplied.
    const response = await app.fetch(new Request('http://example.com/resources/js/leak/secret'))

    expect(response.status).toBe(404)
  })

  it('serves css assets from the resources directory', async () => {
    const response = await app.fetch(new Request('http://example.com/resources/css/app.css'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('background: red')
  })
})

describe('registerDevAssets with roots reached through symlinks', () => {
  const fixture = useAssetFixture('guren-dev-assets-linked-')
  let app: Application

  beforeEach(async () => {
    await fixture.write('real/resources/js/app.tsx', "export const noop = () => 'noop'\n")
    await fixture.write('real/inertia/inertia-client.tsx', "export { chunkValue } from './chunk-helper.ts'\n")
    await fixture.write('real/inertia/chunk-helper.ts', 'export const chunkValue = 42\n')

    // Both roots are handed to the app through a symlink — the shape a workspace,
    // pnpm, or container layout produces. Canonicalizing the candidate without
    // also canonicalizing the root would 404 every request below.
    fixture.symlink('real/resources', 'resources-link')
    fixture.symlink('real/inertia', 'inertia-link')

    app = new Application()
    registerDevAssets(app, {
      resourcesDir: fixture.path('resources-link'),
      inertiaClientSource: fixture.path('inertia-link', 'inertia-client.tsx'),
      inertiaClientPath: '/vendor/inertia-client.tsx',
      inertiaClient: true,
      publicPath: false,
    })
  })

  it('transpiles resources reached through the symlinked root', async () => {
    const response = await app.fetch(new Request('http://example.com/resources/js/app.tsx'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('noop')
  })

  it('serves inertia client chunks reached through the symlinked root', async () => {
    const response = await app.fetch(new Request('http://example.com/vendor/chunk-helper.ts'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('export const chunkValue = 42')
  })
})

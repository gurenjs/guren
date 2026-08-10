import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Application } from '../../src'
import { registerDevAssets } from '../../src/runtime'

describe('registerDevAssets inertia client chunk handling', () => {
  let tmpRoot: string
  let app: Application

  const createFile = async (relative: string, contents: string) => {
    const target = join(tmpRoot, relative)
    await mkdir(dirname(target), { recursive: true })
    await Bun.write(target, contents)
    return target
  }

  beforeEach(async () => {
    // Canonicalized because `os.tmpdir()` is reached through a symlink on macOS
    // (`/var` → `/private/var`); leaving it raw would make containment failures
    // fixture artifacts rather than findings.
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'guren-dev-assets-')))

    // minimal resources directory so the helper can mount the transpiler route
    await createFile('resources/js/app.tsx', "export const noop = () => 'noop'\n")
    await createFile('resources/css/app.css', 'body { background: red; }\n')

    const inertiaEntry = await createFile(
      'inertia/inertia-client.tsx',
      [
        "export const startInertiaClient = () => 'booted'\n",
        "export { chunkValue } from './chunk-helper.ts'\n",
      ].join(''),
    )

    await createFile('inertia/chunk-helper.ts', "export const chunkValue = 42\n")

    // Sibling directory whose name extends the inertia client's own.
    await createFile('inertia-secrets/secret.ts', "export const secret = 'leaked'\n")

    // A directory outside both served roots, linked into each of them. The link
    // is what a lexical containment check cannot see: `resolve()` leaves the
    // path under the root, and only the reader follows it out.
    await createFile('outside/secret.ts', "export const secret = 'leaked'\n")
    await createFile('outside/secret.txt', 'leaked\n')
    symlinkSync(join(tmpRoot, 'outside'), join(tmpRoot, 'inertia', 'leak'))
    symlinkSync(join(tmpRoot, 'outside'), join(tmpRoot, 'resources', 'js', 'leak'))

    app = new Application()
    registerDevAssets(app, {
      resourcesDir: join(tmpRoot, 'resources'),
      inertiaClientSource: inertiaEntry,
      inertiaClientPath: '/vendor/inertia-client.tsx',
      inertiaClient: true,
      publicPath: false,
    })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
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
      new Request(`http://example.com/vendor/${tmpRoot}/inertia-secrets/secret.ts`),
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
    const response = await app.fetch(new Request(`http://example.com/resources/js/${tmpRoot}/outside/secret.ts`))

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
  let tmpRoot: string
  let app: Application

  const createFile = async (relative: string, contents: string) => {
    const target = join(tmpRoot, relative)
    await mkdir(dirname(target), { recursive: true })
    await Bun.write(target, contents)
    return target
  }

  beforeEach(async () => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'guren-dev-assets-linked-')))

    await createFile('real/resources/js/app.tsx', "export const noop = () => 'noop'\n")
    await createFile('real/inertia/inertia-client.tsx', "export { chunkValue } from './chunk-helper.ts'\n")
    await createFile('real/inertia/chunk-helper.ts', 'export const chunkValue = 42\n')

    // Both roots are handed to the app through a symlink — the shape a workspace,
    // pnpm, or container layout produces. Canonicalizing the candidate without
    // also canonicalizing the root would 404 every request below.
    symlinkSync(join(tmpRoot, 'real', 'resources'), join(tmpRoot, 'resources-link'))
    symlinkSync(join(tmpRoot, 'real', 'inertia'), join(tmpRoot, 'inertia-link'))

    app = new Application()
    registerDevAssets(app, {
      resourcesDir: join(tmpRoot, 'resources-link'),
      inertiaClientSource: join(tmpRoot, 'inertia-link', 'inertia-client.tsx'),
      inertiaClientPath: '/vendor/inertia-client.tsx',
      inertiaClient: true,
      publicPath: false,
    })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Application } from '../../src'
import { registerBuiltInertiaClient } from '../../src/http/inertia-assets'

// `configureInertiaAssets` derives this directory from `import.meta.resolve`,
// which cannot be pointed at a fixture — hence the handler is registered
// directly here.
describe('registerBuiltInertiaClient', () => {
  let tmpRoot: string
  let clientDir: string
  let app: Application

  const createFile = async (relative: string, contents: string) => {
    const target = join(tmpRoot, relative)
    await mkdir(dirname(target), { recursive: true })
    await Bun.write(target, contents)
    return target
  }

  beforeEach(async () => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'guren-inertia-client-')))
    clientDir = join(tmpRoot, 'client')

    await createFile('client/app.js', 'export const booted = true\n')
    await createFile('client/chunk-abc.js', 'export const chunkValue = 42\n')
    await createFile('outside/secret.js', "export const secret = 'leaked'\n")

    // Sibling directory whose name merely extends the client's own.
    await createFile('client-secrets/secret.js', "export const secret = 'leaked'\n")

    symlinkSync(join(tmpRoot, 'outside'), join(clientDir, 'leak'))
    symlinkSync(join(tmpRoot, 'outside', 'secret.js'), join(clientDir, 'linked.js'))

    app = new Application()
    registerBuiltInertiaClient(app, clientDir, '/vendor/inertia-client.tsx')
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
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
      new Request(`http://example.com/vendor/${tmpRoot}/client-secrets/secret.js`),
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
  let tmpRoot: string
  let app: Application

  beforeEach(async () => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'guren-inertia-client-linked-')))

    await mkdir(join(tmpRoot, 'real', 'client'), { recursive: true })
    await Bun.write(join(tmpRoot, 'real', 'client', 'app.js'), 'export const booted = true\n')
    await Bun.write(join(tmpRoot, 'real', 'client', 'chunk-abc.js'), 'export const chunkValue = 42\n')

    // The shape a published-package install produces: `node_modules/@guren/…`
    // is a link into another tree.
    symlinkSync(join(tmpRoot, 'real', 'client'), join(tmpRoot, 'client-link'))

    app = new Application()
    registerBuiltInertiaClient(app, join(tmpRoot, 'client-link'), '/vendor/inertia-client.tsx')
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
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

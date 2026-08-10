import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Application } from '../../src'
import { registerRootPublicAssets } from '../../src/http/public-assets'

// These fixtures are real files rather than a stubbed `Bun.file`: containment is
// a property of the filesystem, so a mocked reader would report every one of
// these cases as a pass regardless of what the middleware does.
describe('registerRootPublicAssets', () => {
  let tmpRoot: string
  let publicDir: string
  let app: Application

  const createFile = async (relative: string, contents: string) => {
    const target = join(tmpRoot, relative)
    await mkdir(dirname(target), { recursive: true })
    await Bun.write(target, contents)
    return target
  }

  beforeEach(async () => {
    // Canonicalized: `os.tmpdir()` is behind a symlink on macOS.
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'guren-public-assets-')))
    publicDir = join(tmpRoot, 'public')

    await createFile('public/readme.txt', 'public readme\n')
    await createFile('public/nested/notes.txt', 'nested notes\n')
    await createFile('outside/secret.txt', 'secret\n')

    symlinkSync(join(tmpRoot, 'outside'), join(publicDir, 'leak'))
    symlinkSync(join(tmpRoot, 'outside', 'secret.txt'), join(publicDir, 'linked.txt'))

    app = new Application()
    registerRootPublicAssets(app, publicDir, { extensions: ['txt'] })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
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
    const response = await app.fetch(new Request(`http://example.com/${tmpRoot}/outside/secret.txt`))

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
  let tmpRoot: string
  let app: Application

  beforeEach(async () => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'guren-public-assets-prefix-')))

    await mkdir(join(tmpRoot, 'public', 'assets'), { recursive: true })
    await Bun.write(join(tmpRoot, 'public', 'assets', 'readme.txt'), 'prefixed readme\n')

    app = new Application()
    registerRootPublicAssets(app, join(tmpRoot, 'public'), { extensions: ['txt'], routePrefix: '/assets' })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
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

describe('registerRootPublicAssets with a public directory reached through a symlink', () => {
  let tmpRoot: string
  let app: Application

  beforeEach(async () => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'guren-public-assets-linked-')))

    await mkdir(join(tmpRoot, 'real', 'public'), { recursive: true })
    await Bun.write(join(tmpRoot, 'real', 'public', 'readme.txt'), 'linked readme\n')
    symlinkSync(join(tmpRoot, 'real', 'public'), join(tmpRoot, 'public-link'))

    app = new Application()
    registerRootPublicAssets(app, join(tmpRoot, 'public-link'), { extensions: ['txt'] })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('serves assets through the symlinked public directory', async () => {
    const response = await app.fetch(new Request('http://example.com/readme.txt'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('linked readme')
  })
})

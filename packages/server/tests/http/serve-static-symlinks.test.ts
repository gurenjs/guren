import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Application } from '../../src'
import { registerDevAssets } from '../../src/runtime'

/**
 * Pins the boundary of Guren's symlink containment.
 *
 * The framework's own asset handlers — the dev transpiler, both Inertia client
 * routes, and the root-level public asset middleware — reject a target whose
 * real location is outside the configured root. The `/public/*` and
 * `/resources/css/*` routes are not framework handlers: they are delegated to
 * Hono's `serveStatic`, which follows symlinks out of its root by design (as
 * nginx and `express.static` do). It normalizes `..` and absolute remainders,
 * so lexical traversal is still refused there.
 *
 * These assertions record that split rather than endorse it. Two of them assert
 * a leak: if a future Hono release, or a decision here to stop delegating,
 * changes that, this file is what says so instead of a comment nobody reruns.
 */
describe('symlink containment across the asset routes', () => {
  let tmpRoot: string
  let app: Application

  beforeEach(async () => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'guren-static-symlink-')))

    await mkdir(join(tmpRoot, 'resources', 'js'), { recursive: true })
    await mkdir(join(tmpRoot, 'resources', 'css'), { recursive: true })
    await mkdir(join(tmpRoot, 'public'), { recursive: true })
    await mkdir(join(tmpRoot, 'outside'), { recursive: true })

    await Bun.write(join(tmpRoot, 'outside', 'secret.txt'), 'leaked\n')
    await Bun.write(join(tmpRoot, 'outside', 'secret.css'), '/* leaked */\n')

    // One directory outside every root, linked into the public and css roots.
    symlinkSync(join(tmpRoot, 'outside'), join(tmpRoot, 'public', 'leak'))
    symlinkSync(join(tmpRoot, 'outside'), join(tmpRoot, 'resources', 'css', 'leak'))

    app = new Application()
    registerDevAssets(app, {
      resourcesDir: join(tmpRoot, 'resources'),
      publicDir: join(tmpRoot, 'public'),
      inertiaClient: false,
    })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('refuses a symlink out of the public root on the framework-served root route', async () => {
    const response = await app.fetch(new Request('http://example.com/leak/secret.txt'))

    expect(response.status).toBe(404)
  })

  it('still follows a symlink out of the public root under /public/* (delegated to serveStatic)', async () => {
    const response = await app.fetch(new Request('http://example.com/public/leak/secret.txt'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('leaked')
  })

  it('still follows a symlink out of the css root under /resources/css/* (delegated to serveStatic)', async () => {
    const response = await app.fetch(new Request('http://example.com/resources/css/leak/secret.css'))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('leaked')
  })

  it('refuses lexical traversal under /public/* even though serveStatic follows symlinks', async () => {
    const response = await app.fetch(new Request(`http://example.com/public/${tmpRoot}/outside/secret.txt`))

    expect(response.status).toBe(404)
  })
})

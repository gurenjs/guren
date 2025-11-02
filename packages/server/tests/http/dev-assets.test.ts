import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Application, registerDevAssets } from '../../src'

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
    tmpRoot = mkdtempSync(join(tmpdir(), 'guren-dev-assets-'))

    // minimal resources directory so the helper can mount the transpiler route
    await createFile('resources/js/app.tsx', "export const noop = () => 'noop'\n")

    const inertiaEntry = await createFile(
      'inertia/inertia-client.tsx',
      [
        "export const startInertiaClient = () => 'booted'\n",
        "export { chunkValue } from './chunk-helper.ts'\n",
      ].join(''),
    )

    await createFile('inertia/chunk-helper.ts', "export const chunkValue = 42\n")

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
})

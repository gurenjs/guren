import { beforeEach, describe, expect, it } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Application } from '../../src'
import { registerBuiltInertiaClient } from '../../src/http/inertia-assets'
import { registerDevAssets } from '../../src/runtime'
import { useAssetFixture } from './asset-fixture'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>\n'

/**
 * static-documents.test.ts covers the four routes reaching `public/`. Two more
 * file-serving routes build their own responses: the dev transpile route's static
 * fallback, and the mount serving the built Inertia client from its package
 * directory. Neither is where an upload lands, which is why they are easy to omit.
 */
function expectAttachment(response: Response): void {
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Disposition')).toBe('attachment')
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
}

function expectInline(response: Response): void {
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Disposition')).toBeNull()
}

describe('the dev transpile route serving a file it does not transpile', () => {
  const fixture = useAssetFixture('guren-static-document-transpile-')
  let app: Application

  beforeEach(async () => {
    await fixture.write('resources/js/app.tsx', "export const noop = () => 'noop'\n")
    await fixture.write('resources/js/embed.html', '<script>alert(1)</script>\n')
    await fixture.write('resources/js/diagram.svg', SVG)

    app = new Application()
    registerDevAssets(app, {
      resourcesDir: fixture.path('resources'),
      inertiaClient: false,
      publicPath: false,
    })
  })

  it('forces an HTML file to download', async () => {
    expectAttachment(await app.fetch(new Request('http://example.com/resources/js/embed.html')))
  })

  it('forces an SVG to download', async () => {
    expectAttachment(await app.fetch(new Request('http://example.com/resources/js/diagram.svg')))
  })

  it('keeps serving transpiled modules inline', async () => {
    expectInline(await app.fetch(new Request('http://example.com/resources/js/app.tsx')))
  })
})

describe('the built Inertia client mount', () => {
  const fixture = useAssetFixture('guren-static-document-client-')
  let app: Application

  beforeEach(async () => {
    await fixture.write('dist/app.js', 'export const boot = () => {}\n')
    await fixture.write('dist/widget.svg', SVG)

    app = new Application()
    registerBuiltInertiaClient(app, fixture.path('dist'), '/vendor/inertia-client.tsx')
  })

  it('forces a document type shipped in the client package to download', async () => {
    expectAttachment(await app.fetch(new Request('http://example.com/vendor/widget.svg')))
  })

  it('keeps serving the client bundle inline', async () => {
    expectInline(await app.fetch(new Request('http://example.com/vendor/inertia-client.tsx')))
  })
})

/**
 * A seventh mount added later would typecheck and pass every test in both files:
 * `serveStatic` builds its own response, so a mount that never composes the guard
 * into `onFound` is unreachable from a test unaware of it. These read the source.
 */
describe('the serveStatic mounts in @guren/server', () => {
  // Paths relative to src/. A new entry here is the point: adding one is the
  // moment someone has to decide whether the new mount carries the guard.
  const KNOWN_MOUNTS = ['http/dev-assets.ts', 'http/inertia-assets.ts']

  it('are the ones the document guard has been wired into', async () => {
    const sources = await sourceFiles(join(import.meta.dir, '../../src'))
    const mounts = sources
      .filter(([, code]) => code.includes('serveStatic('))
      .map(([name]) => name)
      .sort()

    expect(mounts).toEqual(KNOWN_MOUNTS)
  })

  it('guard once per mount', async () => {
    const sources = await sourceFiles(join(import.meta.dir, '../../src'))
    const wired = sources.filter(([name]) => KNOWN_MOUNTS.includes(name))

    expect(wired.map(([name]) => name).sort()).toEqual(KNOWN_MOUNTS)

    for (const [name, code] of wired) {
      const mounts = occurrences(code, 'serveStatic(')
      // Every reference but the import binding is a mount being guarded.
      const guards = occurrences(code, 'guardStaticDocument') - 1

      expect(`${name}: ${guards} guarded`).toBe(`${name}: ${mounts} guarded`)
    }
  })
})

/**
 * Every `.ts` source under `dir`, as [path relative to `dir`, code], comments
 * stripped so a mount cannot be talked into passing. Bun's transpiler does the
 * stripping because a regex cannot: the route pattern `'/public/*'` opens a
 * block comment.
 */
async function sourceFiles(dir: string, prefix = ''): Promise<Array<[string, string]>> {
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const entries = await readdir(dir, { withFileTypes: true })
  const files: Array<[string, string]> = []

  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(join(dir, entry.name), relative)))
    } else if (entry.name.endsWith('.ts')) {
      files.push([relative, transpiler.transformSync(await Bun.file(join(dir, entry.name)).text())])
    }
  }

  return files
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1
}

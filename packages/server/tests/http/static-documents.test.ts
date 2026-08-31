import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Application } from '../../src'
import { configureInertiaAssets } from '../../src/http/inertia-assets'
import { registerBuiltInertiaClient } from '../../src/http/inertia-assets'
import { registerRootPublicAssets } from '../../src/http/public-assets'
import { isDocumentContentType } from '../../src/http/static-documents'
import { registerDevAssets } from '../../src/runtime'
import { useAssetFixture } from './asset-fixture'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>\n'

// Real files rather than a stubbed reader: what each mount puts on a response
// is decided from the file it actually resolved.
function expectAttachment(response: Response): void {
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Disposition')).toBe('attachment')
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(response.headers.get('Content-Security-Policy')).toBe('sandbox')
}

/** The negative control: an asset mount must keep serving assets inline. */
function expectInline(response: Response): void {
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Disposition')).toBeNull()
}

describe('isDocumentContentType', () => {
  it('recognizes the types a browser renders as a document', () => {
    expect(isDocumentContentType('image/svg+xml')).toBe(true)
    expect(isDocumentContentType('text/html; charset=utf-8')).toBe(true)
    expect(isDocumentContentType('TEXT/HTML')).toBe(true)
    expect(isDocumentContentType('application/xml')).toBe(true)
    expect(isDocumentContentType('application/xhtml+xml')).toBe(true)
    // The `+xml` structured suffix, so a feed is covered without listing it.
    expect(isDocumentContentType('application/rss+xml')).toBe(true)
  })

  it('leaves assets alone', () => {
    expect(isDocumentContentType('image/png')).toBe(false)
    expect(isDocumentContentType('text/javascript; charset=utf-8')).toBe(false)
    expect(isDocumentContentType('text/css')).toBe(false)
    expect(isDocumentContentType('application/octet-stream')).toBe(false)
    expect(isDocumentContentType(undefined)).toBe(false)
    expect(isDocumentContentType('')).toBe(false)
  })
})

describe('root public assets serving a document type', () => {
  const fixture = useAssetFixture('guren-static-documents-root-')
  let app: Application

  beforeEach(async () => {
    await fixture.write('public/logo.svg', SVG)
    await fixture.write('public/photo.png', 'not really a png\n')

    app = new Application()
    registerRootPublicAssets(app, fixture.path('public'))
  })

  it('forces an SVG to download rather than render as a page', async () => {
    const response = await app.fetch(new Request('http://example.com/logo.svg'))

    expectAttachment(response)
    expect(await response.text()).toContain('<svg')
  })

  it('keeps serving raster images inline', async () => {
    expectInline(await app.fetch(new Request('http://example.com/photo.png')))
  })

  // Without this the `nosniff` assertion above is vacuous: `createSecurityHeaders`
  // puts that header on every response by default, so only an app that turned
  // its own header policy off can show the mount carrying it.
  it('keeps the policy on an app that disabled the security headers middleware', async () => {
    const bare = new Application({ securityHeaders: false })
    registerRootPublicAssets(bare, fixture.path('public'))

    expectAttachment(await bare.fetch(new Request('http://example.com/logo.svg')))
    expect((await bare.fetch(new Request('http://example.com/photo.png'))).headers.get('X-Content-Type-Options')).toBeNull()
  })

  it('applies the policy to a content type the app configured itself', async () => {
    const configured = new Application()
    registerRootPublicAssets(configured, fixture.path('public'), {
      extensions: ['png'],
      contentTypeMap: { '.png': 'text/html' },
    })

    expectAttachment(await configured.fetch(new Request('http://example.com/photo.png')))
  })
})

describe('dev asset serving of document types', () => {
  const fixture = useAssetFixture('guren-static-documents-dev-')
  let app: Application

  beforeEach(async () => {
    await fixture.write('resources/js/app.tsx', "export const noop = () => 'noop'\n")
    await fixture.write('resources/js/embed.html', '<script>alert(1)</script>\n')
    await fixture.write('resources/css/app.css', 'body { color: red }\n')
    await fixture.write('resources/css/diagram.svg', SVG)
    await fixture.write('public/uploads/avatar.svg', SVG)
    await fixture.write('public/page.html', '<script>alert(1)</script>\n')
    await fixture.write('public/photo.png', 'not really a png\n')

    app = new Application()
    registerDevAssets(app, {
      resourcesDir: fixture.path('resources'),
      publicDir: fixture.path('public'),
      inertiaClient: false,
    })
  })

  it('forces an SVG served from the public route to download', async () => {
    expectAttachment(await app.fetch(new Request('http://example.com/public/uploads/avatar.svg')))
  })

  it('forces an HTML file served from the public route to download', async () => {
    expectAttachment(await app.fetch(new Request('http://example.com/public/page.html')))
  })

  it('keeps serving raster images from the public route inline', async () => {
    expectInline(await app.fetch(new Request('http://example.com/public/photo.png')))
  })

  it('forces a document type served by the transpile route to download', async () => {
    expectAttachment(await app.fetch(new Request('http://example.com/resources/js/embed.html')))
  })

  it('keeps serving transpiled modules inline', async () => {
    expectInline(await app.fetch(new Request('http://example.com/resources/js/app.tsx')))
  })

  it('keeps serving stylesheets inline', async () => {
    expectInline(await app.fetch(new Request('http://example.com/resources/css/app.css')))
  })

  it('forces a document type served from the css route to download', async () => {
    expectAttachment(await app.fetch(new Request('http://example.com/resources/css/diagram.svg')))
  })
})

describe('production public asset serving of document types', () => {
  const fixture = useAssetFixture('guren-static-documents-prod-')
  const originalEnv = { ...process.env }
  let app: Application

  beforeEach(async () => {
    process.env = { ...originalEnv }
    process.env.NODE_ENV = 'production'

    await fixture.write('public/uploads/avatar.svg', SVG)
    await fixture.write('public/assets/app-4f2b1c8d.js', 'console.log("hashed")\n')

    app = new Application()
    configureInertiaAssets(app, {
      publicDir: fixture.path('public'),
      inertiaClient: false,
    })
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('forces an SVG under the public route to download', async () => {
    expectAttachment(await app.fetch(new Request('http://example.com/public/uploads/avatar.svg')))
  })

  // The immutable-cache rule this policy now shares `onFound` with is pinned by
  // public-cache-headers.test.ts; what is new here is that a hashed build asset
  // is not treated as a document.
  it('keeps serving hashed build assets inline', async () => {
    expectInline(await app.fetch(new Request('http://example.com/public/assets/app-4f2b1c8d.js')))
  })
})

describe('the built Inertia client mount', () => {
  const fixture = useAssetFixture('guren-static-documents-client-')
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
 * Every mount is covered above, but only the mounts that exist today — a
 * seventh added later would typecheck and pass. `serveStatic` builds its own
 * response, so a mount that does not compose the policy into `onFound` cannot
 * be reached from a test that does not know about it; these read the source
 * instead, the way tests/mcp/endpoint.test.ts pins a form nothing at runtime
 * can tell apart.
 */
describe('the serveStatic mounts in @guren/server', () => {
  // Paths relative to src/. A new entry here is the point: adding one is the
  // moment someone has to decide whether the new mount carries the policy.
  const KNOWN_MOUNTS = ['http/dev-assets.ts', 'http/inertia-assets.ts']

  it('are the ones this policy has been wired into', async () => {
    const sources = await sourceFiles(join(import.meta.dir, '../../src'))
    const mounts = sources
      .filter(([, code]) => code.includes('serveStatic('))
      .map(([name]) => name)
      .sort()

    expect(mounts).toEqual(KNOWN_MOUNTS)
  })

  it('apply the document policy once per mount', async () => {
    const sources = await sourceFiles(join(import.meta.dir, '../../src'))
    const wired = sources.filter(([name]) => KNOWN_MOUNTS.includes(name))

    expect(wired.map(([name]) => name).sort()).toEqual(KNOWN_MOUNTS)

    for (const [name, code] of wired) {
      const mounts = occurrences(code, 'serveStatic(')
      // Every reference but the import binding is an application of the policy.
      const applications = occurrences(code, 'applyStaticDocumentHeaders') - 1

      expect(`${name}: ${applications} applied`).toBe(`${name}: ${mounts} applied`)
    }
  })
})

/**
 * Every `.ts` source under `dir`, as [path relative to `dir`, code], with the
 * comments stripped — a mount must not be talkable into passing. Bun's own
 * transpiler does the stripping because a regex cannot: `'/public/*'` is a
 * route pattern these very files are full of, and it opens a block comment.
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

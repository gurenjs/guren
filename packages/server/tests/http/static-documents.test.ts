import { beforeEach, describe, expect, it } from 'bun:test'
import { mimes } from 'hono/utils/mime'
import { DOCUMENT_ASSET_EXTENSIONS, DOCUMENT_ASSET_HEADERS } from '../../../core/src/internal/deploy-build'
import { Application } from '../../src'
import { configureInertiaAssets, registerDevAssets } from '../../src/runtime'
import { registerRootPublicAssets } from '../../src/http/public-assets'
import { applyDocumentDisposition, rendersAsDocument } from '../../src/http/static-documents'
import { useAssetFixture } from './asset-fixture'

describe('rendersAsDocument', () => {
  const documents = [
    'text/html',
    'text/html; charset=utf-8',
    'TEXT/HTML',
    ' text/html ',
    'image/svg+xml',
    'application/xhtml+xml',
    'application/xslt+xml',
    'text/xml',
    'application/xml',
    'text/xsl',
  ]

  const inert = [
    'text/javascript; charset=utf-8',
    'text/css; charset=utf-8',
    'text/plain; charset=utf-8',
    'image/png',
    'application/pdf',
    'application/octet-stream',
    'application/json',
    'font/woff2',
  ]

  for (const contentType of documents) {
    it(`treats ${JSON.stringify(contentType)} as a document`, () => {
      expect(rendersAsDocument(contentType)).toBe(true)
    })
  }

  for (const contentType of inert) {
    it(`leaves ${JSON.stringify(contentType)} inline`, () => {
      expect(rendersAsDocument(contentType)).toBe(false)
    })
  }

  it('treats an absent content type as inline', () => {
    expect(rendersAsDocument(undefined)).toBe(false)
    expect(rendersAsDocument(null)).toBe(false)
    expect(rendersAsDocument('')).toBe(false)
  })
})

/**
 * The deploy plugins cannot call `rendersAsDocument`: Cloudflare Workers
 * Static Assets and Vercel's CDN both answer for `public/` before the app
 * runs, so each plugin declares the same policy to its platform at build time,
 * keyed on file extension rather than on a content type it never computes.
 * That list lives in `@guren/core/internal/deploy-build`, which deliberately
 * imports nothing from the framework — so this is the seam where the two can
 * drift, and the only place both halves are in scope.
 *
 * Reached by relative path rather than through the package: the module is
 * node-builtins-only, and importing `@guren/core` here would resolve through
 * its `exports` map to a built artifact, making this gate read a stale
 * `dist/` instead of the source it is guarding.
 */
describe('the document extensions the deploy plugins declare', () => {
  it('matches what rendersAsDocument makes of Hono’s mime table', () => {
    // Hono's table is what `getMimeType` reads, and `getMimeType` is what the
    // framework's own static mounts judge a file by — so this recomputes the
    // list from the same inputs rather than restating it.
    const derived = Object.entries(mimes)
      .filter(([, contentType]) => rendersAsDocument(contentType))
      .map(([extension]) => extension)
      .sort()

    expect(derived).toEqual([...DOCUMENT_ASSET_EXTENSIONS])
  })

  it('does not claim the document types Hono names no extension for', () => {
    // `text/xsl` is a document by `rendersAsDocument`, but nothing maps an
    // extension onto it — so `getMimeType` returns undefined for a .xsl file
    // and the framework's own mounts leave it unguarded. The deploy targets
    // are kept level with the app rather than ahead of it.
    expect(rendersAsDocument('text/xsl')).toBe(true)
    expect(Object.keys(mimes)).not.toContain('xsl')
    expect([...DOCUMENT_ASSET_EXTENSIONS]).not.toContain('xsl')
  })

  it('declares the headers the framework guard actually sets', () => {
    // The other half of the same duplication, and the half nothing was
    // holding: the plugins restate the *pair* as data because they cannot
    // call `applyDocumentDisposition`. A header added to the guard — a CSP
    // sandbox directive is the obvious next one — would otherwise ship on the
    // app's own mounts and on none of the deploy targets, with every suite
    // green.
    const headers = new Headers()
    applyDocumentDisposition(headers, 'text/html')

    expect(Object.fromEntries(headers)).toEqual(
      // `Headers` lowercases its names; the constant carries the canonical
      // spelling, which is what the platforms that take a header name
      // verbatim write out.
      Object.fromEntries(
        Object.entries(DOCUMENT_ASSET_HEADERS).map(([name, value]) => [name.toLowerCase(), value]),
      ),
    )
  })

  it('covers the extensions a document type actually arrives under', () => {
    // Anchored so the assertion above cannot pass by both sides going empty,
    // and so a table that stopped naming one of these is a failure here rather
    // than a rule that silently narrows on two deploy targets.
    expect([...DOCUMENT_ASSET_EXTENSIONS]).toEqual(['htm', 'html', 'svg', 'xhtml', 'xml'])
  })
})

/**
 * The `public/` tree is not only the app's build output: the attachments
 * scaffold roots its `public` storage disk inside it, so a file there can be
 * an upload that kept the uploader's own extension. Served as `text/html` or
 * `image/svg+xml` from the app's origin, that is stored XSS.
 *
 * Both routes over the directory are asserted, in both modes, because the
 * two are complementary and a patch to one leaves the other live: the
 * extension allowlist skips `/public/` paths and serves `.svg` at the root,
 * while the `/public/*` mount has no allowlist and serves everything.
 *
 * Written to fail before `guardStaticDocument` / `applyDocumentDisposition`
 * existed: without them every assertion below reads a null header.
 */
describe('document types served out of public/', () => {
  const fixture = useAssetFixture('guren-static-documents-')

  async function seedUploads(): Promise<void> {
    await fixture.write('public/storage/attachments/01ABC/evil.html', '<script>alert(1)</script>\n')
    await fixture.write('public/storage/attachments/01ABC/evil.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
    await fixture.write('public/assets/app.js', 'export const app = 1\n')
    await fixture.write('public/assets/app.css', 'body { color: red }\n')
  }

  describe('the dev /public/* mount', () => {
    let app: Application

    beforeEach(async () => {
      await seedUploads()
      app = new Application()
      registerDevAssets(app, {
        resourcesDir: fixture.path('resources'),
        publicDir: fixture.path('public'),
        inertiaClient: false,
      })
    })

    it('forces an uploaded HTML file to download', async () => {
      const response = await app.fetch(
        new Request('http://example.com/public/storage/attachments/01ABC/evil.html'),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Disposition')).toBe('attachment')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    })

    it('forces an uploaded SVG to download', async () => {
      const response = await app.fetch(
        new Request('http://example.com/public/storage/attachments/01ABC/evil.svg'),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Disposition')).toBe('attachment')
    })

    // Hono's Bun adapter supplies `isDir`, so a directory request resolves to
    // `index.html` *before* onFound runs — which is why the guard is keyed on
    // the path the middleware resolved rather than on `ctx.req.path`. Keying it
    // on the request path would pass every other case in this file and let a
    // directory request through.
    it('forces a directory index to download', async () => {
      await fixture.write('public/site/index.html', '<script>alert(1)</script>\n')

      const response = await app.fetch(new Request('http://example.com/public/site/'))

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Disposition')).toBe('attachment')
    })

    it('forces a document under /resources/css/* to download', async () => {
      await fixture.write('resources/css/evil.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n')

      const response = await app.fetch(new Request('http://example.com/resources/css/evil.svg'))

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Disposition')).toBe('attachment')
    })

    it('leaves scripts and stylesheets inline', async () => {
      const script = await app.fetch(new Request('http://example.com/public/assets/app.js'))
      const styles = await app.fetch(new Request('http://example.com/public/assets/app.css'))

      expect(script.status).toBe(200)
      expect(script.headers.get('Content-Disposition')).toBeNull()
      expect(styles.status).toBe(200)
      expect(styles.headers.get('Content-Disposition')).toBeNull()
    })

    // The escape hatch for a public directory holding no uploads — a static
    // microsite under `public/site/index.html` is the case that needs it.
    it('serves documents inline when the app opts in', async () => {
      const inline = new Application()
      registerDevAssets(inline, {
        resourcesDir: fixture.path('resources'),
        publicDir: fixture.path('public'),
        inertiaClient: false,
        inlineDocuments: true,
      })

      const response = await inline.fetch(
        new Request('http://example.com/public/storage/attachments/01ABC/evil.html'),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Disposition')).toBeNull()
    })
  })

  describe('the production /public/* mount', () => {
    const originalNodeEnv = process.env.NODE_ENV
    let app: Application

    beforeEach(async () => {
      await seedUploads()
      process.env.NODE_ENV = 'production'
      app = new Application()
      configureInertiaAssets(app, {
        publicDir: fixture.path('public'),
        inertiaClient: false,
      })
      process.env.NODE_ENV = originalNodeEnv
    })

    it('forces an uploaded HTML file to download', async () => {
      const response = await app.fetch(
        new Request('http://example.com/public/storage/attachments/01ABC/evil.html'),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Disposition')).toBe('attachment')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    })

    it('keeps the immutable cache header on hashed assets it does not guard', async () => {
      const response = await app.fetch(new Request('http://example.com/public/assets/app.js'))

      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toContain('immutable')
      expect(response.headers.get('Content-Disposition')).toBeNull()
    })
  })

  describe('the root extension allowlist', () => {
    let app: Application

    beforeEach(async () => {
      await seedUploads()
      app = new Application()
      registerRootPublicAssets(app, fixture.path('public'))
    })

    // The allowlist route is reachable for `.svg` even though `.html` is not,
    // so a fix confined to the `/public/*` mount would leave this one serving
    // active content.
    it('forces an uploaded SVG to download', async () => {
      const response = await app.fetch(
        new Request('http://example.com/storage/attachments/01ABC/evil.svg'),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toContain('image/svg+xml')
      expect(response.headers.get('Content-Disposition')).toBe('attachment')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    })

    it('honours a contentTypeMap that renames an extension into a document type', async () => {
      await fixture.write('public/notes.txt', '<script>alert(1)</script>\n')

      const mapped = new Application()
      registerRootPublicAssets(mapped, fixture.path('public'), {
        extensions: ['txt'],
        contentTypeMap: { '.txt': 'text/html; charset=utf-8' },
      })

      const response = await mapped.fetch(new Request('http://example.com/notes.txt'))

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Disposition')).toBe('attachment')
    })

    it('leaves non-document assets inline', async () => {
      await fixture.write('public/logo.png', 'not really a png')

      const response = await app.fetch(new Request('http://example.com/logo.png'))

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Disposition')).toBeNull()
    })

    it('serves documents inline when the app opts in', async () => {
      const inline = new Application()
      registerRootPublicAssets(inline, fixture.path('public'), { inlineDocuments: true })

      const response = await inline.fetch(
        new Request('http://example.com/storage/attachments/01ABC/evil.svg'),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Disposition')).toBeNull()
    })
  })
})

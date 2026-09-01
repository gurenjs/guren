import { beforeEach, describe, expect, it } from 'bun:test'
import { Application } from '../../src'
import { configureInertiaAssets, registerDevAssets } from '../../src/runtime'
import { registerRootPublicAssets } from '../../src/http/public-assets'
import { rendersAsDocument } from '../../src/http/static-documents'
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

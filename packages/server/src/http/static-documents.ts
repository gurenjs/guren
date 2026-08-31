import type { Context } from 'hono'
import { getMimeType } from 'hono/utils/mime'

/**
 * The one rule for "a browser would render this as a document in the serving
 * origin". A file the app merely *stores* under `public/` — an upload keeping
 * its original extension, most of all — otherwise becomes script running as
 * the app: same cookies, same session, same CSRF token.
 *
 * A denylist rather than the attachments engine's `INLINE_CONTENT_TYPES`
 * allowlist, because these mounts also serve the app's own build output. An
 * allowlist here would have to enumerate every asset type a project can ship,
 * and would break a deployment the first time it shipped one that was missed.
 * Everything absent from this set — scripts, stylesheets, fonts, images,
 * media, PDFs — is inert when navigated to, and stays inline.
 */
const DOCUMENT_CONTENT_TYPES = new Set([
  'text/html',
  'text/xml',
  'application/xml',
  'text/xsl',
])

/**
 * Judged on the media type alone. Both inputs this module reads are
 * parameterised — Hono's `getMimeType` returns `text/html; charset=utf-8`, and
 * so does a hand-written `contentTypeMap` entry — so comparing the header
 * verbatim is precisely how the check stops matching while still looking
 * present.
 */
export function rendersAsDocument(contentType: string | undefined | null): boolean {
  if (!contentType) {
    return false
  }

  const mediaType = contentType.split(';', 1)[0]!.trim().toLowerCase()

  // The `+xml` suffix rather than the three names that reach this through
  // Hono's own table (`application/xhtml+xml`, `image/svg+xml`,
  // `application/xslt+xml`): every structured XML type parses as XML, an XML
  // document carries script through an `<?xml-stylesheet?>` PI, and a
  // `contentTypeMap` can name one the table never would.
  return DOCUMENT_CONTENT_TYPES.has(mediaType) || mediaType.endsWith('+xml')
}

/**
 * Neutralizes a served document by turning it into a download.
 *
 * `Content-Disposition: attachment` is honoured for navigations and ignored
 * for subresource loads, which is what makes it usable on a general asset
 * route: `<img src="/logo.svg">`, `<link rel="icon">` and CSS `url()` keep
 * working unchanged, while `/logo.svg` opened directly is downloaded instead
 * of rendered. An `<iframe>` or `<object>` *is* a navigation, so an SVG or
 * HTML page embedded that way stops rendering — which is the same mechanism
 * as the fix, not an exception to it. `nosniff` rides along for the types a
 * browser would otherwise promote on its own.
 */
export function applyDocumentDisposition(headers: Headers, contentType: string | undefined | null): void {
  if (!rendersAsDocument(contentType)) {
    return
  }

  headers.set('Content-Disposition', 'attachment')
  headers.set('X-Content-Type-Options', 'nosniff')
}

/**
 * The {@link import('hono/bun').serveStatic} form of
 * {@link applyDocumentDisposition}, for use as its `onFound` hook.
 *
 * Keyed on the same `getMimeType(path)` the middleware itself used a line
 * earlier to set `Content-Type`, rather than on the extension: the two agree
 * by construction only while they read the same function.
 */
export function guardStaticDocument(path: string, ctx: Context): void {
  if (!rendersAsDocument(getMimeType(path))) {
    return
  }

  ctx.header('Content-Disposition', 'attachment')
  ctx.header('X-Content-Type-Options', 'nosniff')
}

import type { Context } from 'hono'
import { getMimeType } from 'hono/utils/mime'

/**
 * The one rule for "a browser would render this as a document in the serving
 * origin" — otherwise an upload kept under `public/` becomes script running as
 * the app: same cookies, same session, same CSRF token. A denylist rather than
 * the attachments engine's `INLINE_CONTENT_TYPES` allowlist, because these mounts
 * also serve the app's build output and an allowlist breaks the first deployment shipping a type it missed.
 */
const DOCUMENT_CONTENT_TYPES = new Set([
  'text/html',
  'text/xml',
  'application/xml',
  'text/xsl',
])

/**
 * Judged on the media type alone: both inputs are parameterised (`getMimeType`
 * returns `text/html; charset=utf-8`, and so does a `contentTypeMap` entry), so
 * comparing the header verbatim silently stops matching.
 */
export function rendersAsDocument(contentType: string | undefined | null): boolean {
  if (!contentType) {
    return false
  }

  const mediaType = contentType.split(';', 1)[0]!.trim().toLowerCase()

  // The `+xml` suffix rather than the three names Hono's table produces: every
  // structured XML type parses as XML and carries script through an
  // `<?xml-stylesheet?>` PI, and a `contentTypeMap` can name one the table never would.
  return DOCUMENT_CONTENT_TYPES.has(mediaType) || mediaType.endsWith('+xml')
}

/**
 * Neutralizes a served document by turning it into a download.
 * `Content-Disposition: attachment` is honoured for navigations and ignored for
 * subresource loads, so `<img>`, `<link rel="icon">` and CSS `url()` keep
 * working while a direct visit downloads. An `<iframe>`/`<object>` *is* a
 * navigation, so embedding an SVG or HTML page that way stops rendering.
 */
export function applyDocumentDisposition(headers: Headers, contentType: string | undefined | null): void {
  if (!rendersAsDocument(contentType)) {
    return
  }

  headers.set('Content-Disposition', 'attachment')
  headers.set('X-Content-Type-Options', 'nosniff')
}

/**
 * The `serveStatic` `onFound` form of {@link applyDocumentDisposition}. Keyed on
 * the same `getMimeType(path)` that middleware uses for `Content-Type`, not on
 * the extension: the two agree only while they read the same function.
 */
export function guardStaticDocument(path: string, ctx: Context): void {
  if (!rendersAsDocument(getMimeType(path))) {
    return
  }

  ctx.header('Content-Disposition', 'attachment')
  ctx.header('X-Content-Type-Options', 'nosniff')
}

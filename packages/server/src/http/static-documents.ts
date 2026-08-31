import type { Context } from 'hono'
import { getMimeType } from 'hono/utils/mime'

/**
 * The static mounts serve whatever sits under `public/`, and a browser reads
 * some of those files as *documents* rather than as assets: navigated to at
 * their own URL, an `.svg` or an `.html` becomes a page on the serving
 * origin, with script execution and that origin's cookies and storage. Any
 * app that lets a user write a file into the served directory therefore has
 * stored XSS, whatever the app itself renders.
 *
 * `X-Content-Type-Options: nosniff` does not close this — the content type is
 * declared and correct, and the browser is honouring it. Only
 * `Content-Disposition: attachment` takes the response off the document path.
 * Measured in Chrome against a local server: with the header, a top-level
 * navigation downloads instead of executing, while an `<img src>` still
 * decodes the same file (`naturalWidth` unchanged), a CSS `url()` still
 * resolves and a `<link rel="icon">` is still requested — disposition governs
 * the navigate-vs-download decision and is ignored for subresource fetches.
 *
 * This mirrors the policy the attachments delivery route already applies
 * (`INLINE_CONTENT_TYPES` in `@guren/core`'s attachment engine), stated as
 * its complement: delivery serves user uploads and can allowlist what renders
 * inline, while a static mount must keep serving the scripts, stylesheets and
 * fonts a page loads, so what it can enumerate is the document types.
 */
// `image/svg+xml` and `application/xhtml+xml` would already be matched by the
// `+xml` suffix rule below; they are named anyway, because a reader looking for
// the type this policy exists for should find it spelled out.
const DOCUMENT_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  // An XML document can carry an `<?xml-stylesheet?>` pointing at XSLT, which
  // renders as a document of the serving origin like any other.
  'text/xsl',
])

/** Headers that keep a document-typed static response out of the document path. */
const STATIC_DOCUMENT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  // No filename: the browser derives one from the URL, and the request path
  // is the only name a static mount has.
  'Content-Disposition': 'attachment',
  // Restated rather than left to `createSecurityHeaders`, which sets it on
  // every response by default: an app that configures `securityHeaders: false`
  // is turning off its own header policy, not this mount's containment of a
  // file it serves.
  'X-Content-Type-Options': 'nosniff',
  // Belt over the disposition's braces: should a runtime render one of these
  // anyway, it renders with no origin.
  'Content-Security-Policy': 'sandbox',
})

const NO_HEADERS: Readonly<Record<string, string>> = Object.freeze({})

/**
 * Whether `contentType` is one a browser renders as a document. Parameters
 * (`; charset=utf-8`) are ignored, and the `+xml` structured suffix is
 * covered — `application/rss+xml` and friends are XML documents too.
 */
export function isDocumentContentType(contentType: string | null | undefined): boolean {
  if (!contentType) {
    return false
  }

  const essence = contentType.split(';')[0]!.trim().toLowerCase()

  return DOCUMENT_CONTENT_TYPES.has(essence) || essence.endsWith('+xml')
}

/**
 * The safety headers for `contentType`, or an empty object when it is not a
 * document type. Spread into the headers of a response built by hand.
 */
export function staticDocumentHeaders(contentType: string | null | undefined): Readonly<Record<string, string>> {
  return isDocumentContentType(contentType) ? STATIC_DOCUMENT_HEADERS : NO_HEADERS
}

/**
 * The same policy for a Hono `serveStatic` mount, as an `onFound` body.
 *
 * The content type is re-derived from the path with `getMimeType`, which is
 * the function `serveStatic` itself used to set `Content-Type` moments
 * earlier — so this cannot disagree with what is on the response. (Only true
 * while no mount passes `serveStatic`'s own `mimes` option; none do.)
 */
export function applyStaticDocumentHeaders(path: string, ctx: Context): void {
  for (const [name, value] of Object.entries(staticDocumentHeaders(getMimeType(path)))) {
    ctx.header(name, value)
  }
}

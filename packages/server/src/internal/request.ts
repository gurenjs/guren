/**
 * The one set of request-reading rules: which content types are read, how a
 * repeated form field collapses, what an unreadable body falls back to, how a
 * multipart upload is pulled off the request, and how repeated query
 * parameters flatten for a validation schema.
 *
 * `@guren/testing`'s controller mock reads them through this subpath so a
 * mocked controller and a real one cannot disagree about a request. The mock
 * holds a `Request` rather than a Hono context, so it adapts — it wraps the
 * request in a `HonoRequest` and calls straight into these — rather than
 * reimplementing the decisions. A second copy is how the two came to disagree
 * on an uppercase media type, on a `;`-parameterized one, and on a repeated
 * `field[]`.
 *
 * `parseRequestUploads` is here for the same reason and one of its own. It is
 * not `parseRequestBody` with a different name: it parses with `{ all: true }`,
 * so a field repeated in the body stays an array for `files()` instead of
 * collapsing to its first value. Routing uploads through the body parser would
 * silently reduce `files()` to one file per field, which no malformed-body test
 * can see.
 *
 * Internal by the rules in `contributing/api-stability.md` — reachable only
 * through a deep import under `internal/`, never re-exported from an index.
 * `parseRequestPayload` beside them *is* public and stays exported from the
 * package root; this subpath exists for the ones that are not.
 */
export {
  parseRequestBody,
  parseRequestUploads,
  asRecord,
  flattenRequestQueries,
} from '../http/request'
export type {
  RequestBodyContext,
  RequestQueryContext,
  RequestUploads,
  RequestUploadsContext,
} from '../http/request'

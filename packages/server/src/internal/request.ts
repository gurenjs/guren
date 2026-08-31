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
 * `parseRequestUploads` is here for the same reason. It is deliberately not
 * `parseRequestBody` under another name — its own doc comment owns why, and is
 * the one place that argument is written out.
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

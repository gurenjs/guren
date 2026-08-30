/**
 * The one request-body parsing rule: which content types are read, how a
 * repeated form field collapses, and what an unreadable body falls back to.
 *
 * `@guren/testing`'s controller mock reads it through this subpath so a
 * mocked controller and a real one cannot disagree about a body. The mock
 * holds a `Request` rather than a Hono context, so it adapts — it wraps the
 * request in a `HonoRequest` and calls straight into these — rather than
 * reimplementing the decision. A second copy is how the two came to disagree
 * on an uppercase media type, on a `;`-parameterized one, and on a repeated
 * `field[]`.
 *
 * Internal by the rules in `contributing/api-stability.md` — reachable only
 * through a deep import under `internal/`, never re-exported from an index.
 * `parseRequestPayload` beside it *is* public and stays exported from the
 * package root; this subpath exists for the two that are not.
 */
export { parseRequestBody, asRecord } from '../http/request'

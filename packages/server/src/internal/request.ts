/**
 * The one set of request-reading rules: which content types are read, how a
 * repeated form field collapses, what an unreadable body falls back to, how a
 * multipart upload is read, and how repeated query parameters flatten.
 * `@guren/testing`'s controller mock wraps its `Request` in a `HonoRequest` and
 * calls into these rather than restating them — a second copy is how the two
 * came to disagree on an uppercase media type and on a repeated `field[]`.
 * Internal per `contributing/api-stability.md`: reachable only through this
 * deep import. `parseRequestPayload` beside them is public.
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

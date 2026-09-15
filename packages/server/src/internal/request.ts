/**
 * The one set of request-reading rules: which content types are read, how a
 * repeated form field collapses, what an unreadable body falls back to, how a
 * multipart upload is read, and how repeated query parameters flatten.
 * `@guren/testing` imports these instead of restating them. Keep every name: published
 * `@guren/testing` releases import some that its current source does not.
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
// The record the contract middleware leaves for `Controller.validated()`; the
// controller mock seeds it under the same key and reads it through the same function.
export { VALIDATED_INPUT_CONTEXT_KEY, readValidatedInput } from '../mvc/validated-input'
export type { UntypedValidatedInput, ValidatedInputRecord } from '../mvc/validated-input'

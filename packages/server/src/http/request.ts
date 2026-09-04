import type { HonoRequest } from 'hono'

import type { Context } from './Application'

/**
 * What {@link parseRequestBody} reads, not a whole Hono context. `parseBody` is
 * optional here so `@guren/testing`'s controller mock — a `HonoRequest` built
 * from a plain `Request` — satisfies it without a cast; that is also what makes
 * the `typeof` guard below live rather than dead code. Narrowing accepts
 * strictly more callers, so existing ones keep passing a real `Context`.
 */
export interface RequestBodyContext {
  req: Pick<HonoRequest, 'header' | 'json'> & Partial<Pick<HonoRequest, 'parseBody'>>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Returns the parsed body as-is (a JSON array stays an array), for callers that
 * hand it to a schema. Any unparseable body falls back to `{}` so an all-optional
 * object schema still passes on an empty POST; the cost is that a non-object
 * schema then fails validation instead of receiving nothing. The fallback cannot
 * say whose fault it was — a client's malformed body and one already consumed
 * upstream both read as `{}`, since telling them apart means matching error
 * codes that differ on Bun, Node and Workers.
 */
export async function parseRequestBody(ctx: RequestBodyContext): Promise<unknown> {
  const contentType = ctx.req.header('content-type') ?? ''

  if (contentType.includes('application/json')) {
    return ctx.req.json().catch(() => ({}))
  }

  if (typeof ctx.req.parseBody === 'function') {
    // The single fallback every caller depends on: an undecodable form body
    // (wrong MIME type, missing multipart boundary) is a client error, so it
    // reaches the schema as `{}` rather than escaping as a 500. try/catch rather
    // than `.catch()` — `parseBody` may throw synchronously as well as reject.
    try {
      const form = await ctx.req.parseBody()
      return Object.fromEntries(
        Object.entries(form).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
      )
    } catch {
      return {}
    }
  }

  return {}
}

/**
 * The same narrowing as {@link RequestBodyContext}, but `parseBody` is required:
 * there is no second way to read an upload, so a caller that cannot supply one
 * should fail to compile rather than silently answer "no files".
 */
export interface RequestUploadsContext {
  req: Pick<HonoRequest, 'parseBody'>
}

/** Hono's `{ all: true }` record: a repeated field is an array, a single one is not. */
export type RequestUploads = Record<string, string | File | (string | File)[]>

/**
 * The one multipart read behind `Controller.file()`/`files()`. `{ all: true }` is
 * the contract, so this is deliberately *not* routed through
 * {@link parseRequestBody}, which flattens a repeated field to its first value.
 * No media-type gate, deliberately: Hono lowercases it inside `parseBody()`, so
 * an uppercase `MULTIPART/FORM-DATA` body works here while a caller gating first
 * — or reading through `Request.formData()` — answers `null` (measured on Bun
 * 1.3.14; 1.4.0 and Node accept it). try/catch rather than `.catch()`, since
 * `parseBody` may throw synchronously; an undecodable or already-consumed body
 * therefore reads as no files rather than a 500.
 */
export async function parseRequestUploads(ctx: RequestUploadsContext): Promise<RequestUploads> {
  try {
    return await ctx.req.parseBody({ all: true })
  } catch {
    return {}
  }
}

/**
 * The record-shaped view of {@link parseRequestBody}, for callers reading the
 * payload field by field. A body that is not a plain object becomes `{}`.
 */
export async function parseRequestPayload(ctx: Context): Promise<Record<string, unknown>> {
  return asRecord(await parseRequestBody(ctx))
}

/** Narrow a parsed body to the record view described on {@link parseRequestPayload}. */
export function asRecord(body: unknown): Record<string, unknown> {
  return isPlainObject(body) ? body : {}
}

/**
 * Spelled as the call shape rather than `Pick<HonoRequest, 'queries'>`, which
 * would keep both overloads and so reject the plain
 * `() => Record<string, string[]>` `@guren/testing` declares. Naming the one
 * signature admits both, since an overloaded member is assignable to any of its
 * own signatures.
 */
export interface RequestQueryContext {
  req: {
    queries(): Record<string, string[]>
  }
}

/**
 * Query parameters with repeated keys kept as arrays and single ones as strings.
 * Use instead of `ctx.req.query()` when feeding a validation schema.
 * Must be materialized with `Object.fromEntries`, never by assigning into an
 * object literal: query keys are attacker-controlled, and `flat['__proto__'] = …`
 * hits `Object.prototype`'s inherited setter instead of defining a field.
 */
export function flattenRequestQueries(ctx: RequestQueryContext): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(ctx.req.queries()).map(([key, values]) => [
      key,
      values.length === 1 ? values[0] : values,
    ]),
  )
}

export interface ValidationIssueLike {
  path: PropertyKey[]
  message: string
}

export interface ValidationErrorLike {
  issues: ValidationIssueLike[]
}

/** Converts a Zod-style validation error into a flat record usable by forms. */
export function formatValidationErrors(
  error: ValidationErrorLike,
  fallbackMessage = 'The provided data is invalid.',
): Record<string, string> {
  const errors: Record<string, string> = {}

  for (const issue of error.issues ?? []) {
    const field = issue.path?.[0]
    if (typeof field === 'string' && !errors[field]) {
      errors[field] = issue.message
    }
  }

  if (Object.keys(errors).length === 0) {
    errors.message = fallbackMessage
  }

  return errors
}

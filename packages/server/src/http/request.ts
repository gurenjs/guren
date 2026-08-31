import type { HonoRequest } from 'hono'

import type { Context } from './Application'

/**
 * What {@link parseRequestBody} actually reads: three members off `ctx.req`,
 * not a whole Hono context.
 *
 * Declared structurally because the difference is load bearing. `parseBody` is
 * optional here, which is what makes the `typeof` guard below meaningful — a
 * real `Context` always carries one, so against `Context` that guard reads as
 * dead code. It is not: `@guren/testing`'s controller mock reaches this parser
 * through a `HonoRequest` built from a plain `Request`, and this is the
 * declaration that lets it do so without casting its way past the signature.
 *
 * Narrowing a parameter accepts strictly more callers, so every existing one —
 * `Router`, `Controller`, the validation middleware, `FormRequest`,
 * `BroadcastManager` — keeps passing a real `Context` unchanged.
 */
export interface RequestBodyContext {
  req: Pick<HonoRequest, 'header' | 'json'> & Partial<Pick<HonoRequest, 'parseBody'>>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses the incoming request body and returns the parsed value as-is: a JSON
 * array stays an array, a JSON string stays a string. Use this wherever the
 * result is handed to a schema and *that* decides the shape — a route
 * contract's `body`, `Controller.validateBody()`, `validateRequest()`.
 *
 * Falls back to an empty object when the body cannot be parsed (malformed
 * JSON, a form body the parser cannot decode, an empty POST, an unsupported
 * content type). That fallback is load bearing: an all-optional object schema
 * has to keep passing on an empty body, which `undefined` would break. The
 * cost is that a non-object schema sees `{}` there and fails validation,
 * rather than receiving nothing.
 *
 * The fallback does not distinguish whose fault the failure was: a body the
 * client could never have sent correctly and a body already consumed upstream
 * (middleware reading `ctx.req.raw` directly, bypassing Hono's cache) both read
 * as `{}` here. That is deliberate — the JSON branch above has always behaved
 * this way, and telling the two apart means matching runtime-specific error
 * codes, which would answer differently on Bun, Node and Workers. A parser
 * error is a poor signal for a middleware-ordering bug either way.
 *
 * Form submissions have no non-object shape to preserve, so they normalize to
 * a record exactly as {@link parseRequestPayload} does.
 */
export async function parseRequestBody(ctx: RequestBodyContext): Promise<unknown> {
  const contentType = ctx.req.header('content-type') ?? ''

  if (contentType.includes('application/json')) {
    return ctx.req.json().catch(() => ({}))
  }

  if (typeof ctx.req.parseBody === 'function') {
    // This catch is the single fallback every caller depends on, which is why
    // it lives here rather than in any one of them: a form body the parser
    // cannot decode (wrong MIME type, missing multipart boundary) is a client
    // error, so it reaches the schema as `{}` and fails validation like any
    // other bad payload. Left to throw, it surfaced as a 500 reporting a
    // TypeError and a stack on every path that did not catch it.
    //
    // try/catch rather than `.catch()`: `parseBody` may throw synchronously
    // as well as reject, and only one of those two shapes reaches a `.catch()`.
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
 * What {@link parseRequestUploads} reads: one member off `ctx.req`, not a whole
 * Hono context — the same narrowing, and for the same caller, as
 * {@link RequestBodyContext}.
 *
 * `parseBody` is required here where the body parser makes it optional. That
 * parser has a fallback for a context without one; this has none, because
 * there is no second way to read an upload. A caller that cannot supply
 * `parseBody` should fail to compile rather than silently answer "no files".
 */
export interface RequestUploadsContext {
  req: Pick<HonoRequest, 'parseBody'>
}

/**
 * The shape an upload read answers with: Hono's `{ all: true }` record, where a
 * field repeated in the body is an array and a single one is not.
 */
export type RequestUploads = Record<string, string | File | (string | File)[]>

/**
 * The one multipart read behind `Controller.file()` and `Controller.files()`,
 * guarded so a body the parser cannot decode carries no files rather than
 * crashing the request: it reads as `{}`, which is the same answer both helpers
 * already give for a field that is simply absent — `null` and `[]`. Left to
 * throw, the parser's `TypeError` escaped as a 500 reporting the exception and
 * a stack, the defect {@link parseRequestBody} fixes for the validation paths.
 *
 * Deliberately *not* routed through {@link parseRequestBody}, which looks like
 * the same rule and is not: it parses without `{ all: true }` and flattens a
 * repeated field to its first value, so sharing it would silently reduce
 * `files()` to one file per field. `{ all: true }` is the contract here, and a
 * malformed-body test cannot see its loss — hence the separate function.
 *
 * There is no media-type gate, deliberately: Hono decides the media type inside
 * `parseBody()`, having lowercased it first. A caller that gates before calling
 * — or that reads uploads through `Request.formData()`, whose handling of the
 * media type is not Hono's — answers `null` for an uppercase
 * `MULTIPART/FORM-DATA` body this returns the file for.
 *
 * That was measured on Bun 1.3.14, and the host half of it has already moved:
 * Bun 1.4.0 accepts the same header `1.3.14` rejects, and Node always did. The
 * divergence is therefore a property of *where the media type is decided*, not
 * of any one runtime — which is the argument for deciding it in one place, and
 * why `@guren/testing`'s controller mock reaches this function rather than
 * restating it.
 *
 * try/catch rather than `.catch()`, for the reason given on the shared
 * fallback: `parseBody` may throw synchronously as well as reject, and only one
 * of those two shapes reaches a `.catch()`.
 *
 * It fails open in one direction, deliberately and for the same reason
 * {@link parseRequestBody} does: a body already consumed upstream reads as
 * "no upload" rather than throwing, so a middleware-ordering bug loses the 500
 * that used to announce it. Telling that apart from a client's malformed body
 * means matching runtime-specific error codes, which answer differently on Bun,
 * Node and Workers.
 */
export async function parseRequestUploads(ctx: RequestUploadsContext): Promise<RequestUploads> {
  try {
    return await ctx.req.parseBody({ all: true })
  } catch {
    return {}
  }
}

/**
 * The record-shaped view of {@link parseRequestBody}, for callers that read the
 * payload field by field (`payload.channel`, per-field validation rules,
 * `Controller.input()`/`only()`/`except()`/`has()`). A body that is not a plain
 * object — an array, a string, `null` — becomes `{}`, because there is no
 * field to read on one.
 */
export async function parseRequestPayload(ctx: Context): Promise<Record<string, unknown>> {
  return asRecord(await parseRequestBody(ctx))
}

/** Narrow a parsed body to the record view described on {@link parseRequestPayload}. */
export function asRecord(body: unknown): Record<string, unknown> {
  return isPlainObject(body) ? body : {}
}

/**
 * What {@link flattenRequestQueries} actually reads: one no-arg `queries()` off
 * `ctx.req`, not a whole Hono context.
 *
 * Spelled as the call shape rather than as `Pick<HonoRequest, 'queries'>` — the
 * one place this departs from {@link RequestBodyContext} above, and not by
 * preference. `HonoRequest.queries` is *overloaded* (`queries(key)` returning
 * `string[] | undefined`, `queries()` returning the record), and a `Pick` keeps
 * both signatures, so the plain `() => Record<string, string[]>` that
 * `@guren/testing`'s `ControllerContext` declares cannot satisfy it. Naming the
 * one signature this function calls admits both: an overloaded member is
 * assignable to any of its own signatures, so a real `HonoRequest` still passes.
 *
 * Narrowing a parameter accepts strictly more callers, so every existing one
 * keeps passing a real `Context` unchanged.
 */
export interface RequestQueryContext {
  req: {
    queries(): Record<string, string[]>
  }
}

/**
 * Collects query parameters preserving repeated keys as arrays while keeping
 * single occurrences as plain strings (`?tag=a&tag=b` → `{ tag: ['a', 'b'] }`,
 * `?page=2` → `{ page: '2' }`). Use this instead of `ctx.req.query()` when
 * feeding query data into validation schemas.
 *
 * Materialized with `Object.fromEntries`, never by assigning into an object
 * literal — the same rule, and for the same reason, as the form branch of
 * {@link parseRequestBody} above. Query keys are attacker-controlled, and
 * `flat['__proto__'] = …` hits `Object.prototype`'s inherited setter instead
 * of defining a field: `?__proto__=one` silently vanished before reaching the
 * schema, and `?__proto__=one&__proto__=two` set the returned record's own
 * prototype to that array. Hono hands over a null-prototype object, so the
 * key arrives here intact; only this last step could lose it.
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

/**
 * Converts a Zod-style validation error into a flat record usable by forms.
 */
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

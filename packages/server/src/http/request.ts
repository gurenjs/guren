import type { Context } from './Application'

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
 * JSON, an empty POST, an unsupported content type). That fallback is load
 * bearing: an all-optional object schema has to keep passing on an empty
 * body, which `undefined` would break. The cost is that a non-object schema
 * sees `{}` there and fails validation, rather than receiving nothing.
 *
 * Form submissions have no non-object shape to preserve, so they normalize to
 * a record exactly as {@link parseRequestPayload} does.
 */
export async function parseRequestBody(ctx: Context): Promise<unknown> {
  const contentType = ctx.req.header('content-type') ?? ''

  if (contentType.includes('application/json')) {
    return ctx.req.json().catch(() => ({}))
  }

  if (typeof ctx.req.parseBody === 'function') {
    const form = await ctx.req.parseBody()
    return Object.fromEntries(
      Object.entries(form).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
    )
  }

  return {}
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
 * Collects query parameters preserving repeated keys as arrays while keeping
 * single occurrences as plain strings (`?tag=a&tag=b` → `{ tag: ['a', 'b'] }`,
 * `?page=2` → `{ page: '2' }`). Use this instead of `ctx.req.query()` when
 * feeding query data into validation schemas.
 */
export function flattenRequestQueries(ctx: Context): Record<string, unknown> {
  const queries = ctx.req.queries()
  const flat: Record<string, unknown> = {}
  for (const [key, values] of Object.entries(queries)) {
    flat[key] = values.length === 1 ? values[0] : values
  }
  return flat
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

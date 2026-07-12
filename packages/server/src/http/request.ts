import type { Context } from './Application'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses the incoming request payload supporting both JSON bodies and form submissions.
 * Falls back to an empty object if the payload cannot be parsed.
 */
export async function parseRequestPayload(ctx: Context): Promise<Record<string, unknown>> {
  const contentType = ctx.req.header('content-type') ?? ''

  if (contentType.includes('application/json')) {
    const body = await ctx.req.json().catch(() => ({}))
    return isPlainObject(body) ? body : {}
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

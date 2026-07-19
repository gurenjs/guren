import type { Context, MiddlewareHandler } from 'hono'
import { jsonResponse } from './index'
import { parseRequestPayload, formatValidationErrors, type ValidationErrorLike } from '../request'

export const VALIDATED_DATA_KEY = 'guren:validated'

export interface ValidationSchema<T = unknown> {
  parse(data: unknown): T
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: ValidationErrorLike }
}

export interface ValidateRequestOptions {
  /**
   * Custom error handler when validation fails.
   * Defaults to returning a 422 JSON response with formatted errors.
   */
  onError?: (ctx: Context, errors: Record<string, string>) => Response | Promise<Response>

  /**
   * HTTP status code for validation errors.
   * Defaults to 422 (Unprocessable Entity).
   */
  status?: number

  /**
   * Fallback message when no field-specific errors are available.
   */
  fallbackMessage?: string
}

/**
 * Get validated data from the request context.
 * Returns undefined if validation middleware hasn't run or validation failed.
 */
export function getValidatedData<T = Record<string, unknown>>(ctx: Context): T | undefined {
  return ctx.get(VALIDATED_DATA_KEY) as T | undefined
}

/**
 * Creates a validation middleware that validates the request body against a Zod schema.
 *
 * @example
 * ```ts
 * import { z } from 'zod'
 * import { validateRequest, getValidatedData } from '@guren/server'
 *
 * const CreateUserSchema = z.object({
 *   name: z.string().min(1),
 *   email: z.email(),
 * })
 *
 * app.post('/users', validateRequest(CreateUserSchema), (c) => {
 *   const data = getValidatedData<z.infer<typeof CreateUserSchema>>(c)
 *   // data is typed and validated
 *   return c.json({ user: data })
 * })
 * ```
 */
export function validateRequest<T>(
  schema: ValidationSchema<T>,
  options: ValidateRequestOptions = {},
): MiddlewareHandler {
  const { onError, status = 422, fallbackMessage = 'The provided data is invalid.' } = options

  return async (ctx, next) => {
    const payload = await parseRequestPayload(ctx)
    const result = schema.safeParse(payload)

    if (!result.success) {
      const errors = formatValidationErrors(result.error, fallbackMessage)

      if (onError) {
        return onError(ctx, errors)
      }

      return jsonResponse({ errors }, status)
    }

    ctx.set(VALIDATED_DATA_KEY, result.data)
    await next()
  }
}

/**
 * Creates a validation middleware from a schema factory function.
 * Useful when the schema depends on request context.
 *
 * @example
 * ```ts
 * app.post('/users/:role', validateRequestWith((ctx) => {
 *   const role = ctx.req.param('role')
 *   return role === 'admin' ? AdminSchema : UserSchema
 * }), handler)
 * ```
 */
export function validateRequestWith<T>(
  schemaFactory: (ctx: Context) => ValidationSchema<T>,
  options: ValidateRequestOptions = {},
): MiddlewareHandler {
  const { onError, status = 422, fallbackMessage = 'The provided data is invalid.' } = options

  return async (ctx, next) => {
    const schema = schemaFactory(ctx)
    const payload = await parseRequestPayload(ctx)
    const result = schema.safeParse(payload)

    if (!result.success) {
      const errors = formatValidationErrors(result.error, fallbackMessage)

      if (onError) {
        return onError(ctx, errors)
      }

      return jsonResponse({ errors }, status)
    }

    ctx.set(VALIDATED_DATA_KEY, result.data)
    await next()
  }
}

/**
 * Validates data against a schema and throws if invalid.
 * Useful for manual validation in handlers.
 *
 * @example
 * ```ts
 * app.post('/data', async (c) => {
 *   const payload = await parseRequestPayload(c)
 *   const data = validate(MySchema, payload)
 *   // throws ValidationError if invalid
 *   return c.json(data)
 * })
 * ```
 */
export function validate<T>(schema: ValidationSchema<T>, data: unknown): T {
  return schema.parse(data)
}

/**
 * Validates data against a schema and returns a result object.
 * Does not throw on validation failure.
 */
export function validateSafe<T>(
  schema: ValidationSchema<T>,
  data: unknown,
): { success: true; data: T } | { success: false; errors: Record<string, string> } {
  const result = schema.safeParse(data)

  if (result.success) {
    return { success: true, data: result.data }
  }

  return { success: false, errors: formatValidationErrors(result.error) }
}

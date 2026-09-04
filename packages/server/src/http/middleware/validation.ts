import type { Context, MiddlewareHandler } from 'hono'
import { jsonResponse } from './index'
import { parseRequestBody, formatValidationErrors, type ValidationErrorLike } from '../request'

export const VALIDATED_DATA_KEY = 'guren:validated'

export interface ValidationSchema<T = unknown> {
  parse(data: unknown): T
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: ValidationErrorLike }
}

export interface ValidateRequestOptions {
  /** Defaults to a 422 JSON response with formatted errors. */
  onError?: (ctx: Context, errors: Record<string, string>) => Response | Promise<Response>

  /** @default 422 */
  status?: number

  /** Used when no field-specific errors are available. */
  fallbackMessage?: string
}

/** Undefined when the validation middleware has not run, or validation failed. */
export function getValidatedData<T = Record<string, unknown>>(ctx: Context): T | undefined {
  return ctx.get(VALIDATED_DATA_KEY) as T | undefined
}

/**
 * Validates the request body against a schema; read it with {@link getValidatedData}.
 */
export function validateRequest<T>(
  schema: ValidationSchema<T>,
  options: ValidateRequestOptions = {},
): MiddlewareHandler {
  const { onError, status = 422, fallbackMessage = 'The provided data is invalid.' } = options

  return async (ctx, next) => {
    const payload = await parseRequestBody(ctx)
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

/** Like {@link validateRequest}, for a schema that depends on request context. */
export function validateRequestWith<T>(
  schemaFactory: (ctx: Context) => ValidationSchema<T>,
  options: ValidateRequestOptions = {},
): MiddlewareHandler {
  const { onError, status = 422, fallbackMessage = 'The provided data is invalid.' } = options

  return async (ctx, next) => {
    const schema = schemaFactory(ctx)
    const payload = await parseRequestBody(ctx)
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

/** Manual validation for handlers; throws when the data is invalid. */
export function validate<T>(schema: ValidationSchema<T>, data: unknown): T {
  return schema.parse(data)
}

/** Like {@link validate}, but reports failure in the result instead of throwing. */
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

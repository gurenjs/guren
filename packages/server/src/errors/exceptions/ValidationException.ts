import { HttpException } from '../HttpException'

/**
 * Validation exception.
 *
 * Thrown when request validation fails.
 *
 * @example
 * ```typescript
 * throw new ValidationException({
 *   email: ['Email is required', 'Email must be valid'],
 *   password: ['Password is too short'],
 * })
 * ```
 */
export class ValidationException extends HttpException {
  constructor(
    errors: Record<string, string[]>,
    message: string = 'The given data was invalid.'
  ) {
    super(422, message, errors)
    this.name = 'ValidationException'
  }

  /**
   * Create from Zod error.
   */
  static fromZodError(zodError: ZodLikeError): ValidationException {
    const errors: Record<string, string[]> = {}

    for (const issue of zodError.issues) {
      const path = issue.path.join('.')
      if (!errors[path]) {
        errors[path] = []
      }
      errors[path].push(issue.message)
    }

    return new ValidationException(errors)
  }

  /**
   * Get errors for a specific field.
   */
  getFieldErrors(field: string): string[] {
    return this.errors?.[field] ?? []
  }

  /**
   * Check if a field has errors.
   */
  hasFieldError(field: string): boolean {
    return (this.errors?.[field]?.length ?? 0) > 0
  }

  /**
   * Get the first error for a field.
   */
  getFirstError(field: string): string | null {
    return this.errors?.[field]?.[0] ?? null
  }

  /**
   * Get all error messages as a flat array.
   */
  getAllMessages(): string[] {
    if (!this.errors) return []
    return Object.values(this.errors).flat()
  }
}

/**
 * Zod-like error interface for compatibility.
 */
interface ZodLikeError {
  issues: Array<{
    path: (string | number)[]
    message: string
  }>
}

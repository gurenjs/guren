import { HttpException } from '../HttpException'

/** 422: request validation failed. */
export class ValidationException extends HttpException {
  constructor(
    errors: Record<string, string[]>,
    message: string = 'The given data was invalid.'
  ) {
    super(422, message, errors)
    this.name = 'ValidationException'
  }

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

  getFieldErrors(field: string): string[] {
    return this.errors?.[field] ?? []
  }

  hasFieldError(field: string): boolean {
    return (this.errors?.[field]?.length ?? 0) > 0
  }

  getFirstError(field: string): string | null {
    return this.errors?.[field]?.[0] ?? null
  }

  getAllMessages(): string[] {
    if (!this.errors) return []
    return Object.values(this.errors).flat()
  }

  /** For business-logic validation, where Zod is not involved. */
  static withMessages(messages: Record<string, string | string[]>): ValidationException {
    const errors: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(messages)) {
      errors[key] = Array.isArray(value) ? value : [value]
    }
    return new ValidationException(errors)
  }
}

interface ZodLikeError {
  issues: Array<{
    path: PropertyKey[]
    message: string
  }>
}

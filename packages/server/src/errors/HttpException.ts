import type { ErrorResponse } from './types'

/**
 * Base HTTP exception class.
 *
 * @example
 * ```typescript
 * // Using factory methods
 * throw HttpException.notFound('User not found')
 * throw HttpException.unauthorized('Invalid credentials')
 *
 * // Custom status code
 * throw new HttpException(418, "I'm a teapot")
 *
 * // With validation errors
 * throw HttpException.unprocessable('Validation failed', {
 *   email: ['Email is required', 'Email must be valid'],
 *   password: ['Password is too short'],
 * })
 * ```
 */
export class HttpException extends Error {
  /**
   * HTTP status code.
   */
  readonly statusCode: number

  /**
   * Validation or field-specific errors.
   */
  readonly errors?: Record<string, string[]>

  /**
   * Additional error data.
   */
  readonly data?: Record<string, unknown>

  constructor(
    statusCode: number,
    message: string,
    errors?: Record<string, string[]>,
    data?: Record<string, unknown>
  ) {
    super(message)
    this.name = this.constructor.name
    this.statusCode = statusCode
    this.errors = errors
    this.data = data

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
  }

  /**
   * Convert to response format.
   */
  toResponse(debug: boolean = false): { status: number; body: ErrorResponse } {
    const body: ErrorResponse = {
      message: this.message,
    }

    if (this.errors) {
      body.errors = this.errors
    }

    if (debug) {
      body.exception = this.name
      body.stack = this.stack
    }

    return {
      status: this.statusCode,
      body,
    }
  }

  /**
   * Convert to JSON.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      statusCode: this.statusCode,
      errors: this.errors,
      data: this.data,
    }
  }

  // Factory methods

  /**
   * Create a 400 Bad Request exception.
   */
  static badRequest(message: string = 'Bad Request'): HttpException {
    return new HttpException(400, message)
  }

  /**
   * Create a 401 Unauthorized exception.
   */
  static unauthorized(message: string = 'Unauthorized'): HttpException {
    return new HttpException(401, message)
  }

  /**
   * Create a 403 Forbidden exception.
   */
  static forbidden(message: string = 'Forbidden'): HttpException {
    return new HttpException(403, message)
  }

  /**
   * Create a 404 Not Found exception.
   */
  static notFound(message: string = 'Not Found'): HttpException {
    return new HttpException(404, message)
  }

  /**
   * Create a 405 Method Not Allowed exception.
   */
  static methodNotAllowed(message: string = 'Method Not Allowed'): HttpException {
    return new HttpException(405, message)
  }

  /**
   * Create a 409 Conflict exception.
   */
  static conflict(message: string = 'Conflict'): HttpException {
    return new HttpException(409, message)
  }

  /**
   * Create a 410 Gone exception.
   */
  static gone(message: string = 'Gone'): HttpException {
    return new HttpException(410, message)
  }

  /**
   * Create a 422 Unprocessable Entity exception.
   */
  static unprocessable(
    message: string = 'Unprocessable Entity',
    errors?: Record<string, string[]>
  ): HttpException {
    return new HttpException(422, message, errors)
  }

  /**
   * Create a 429 Too Many Requests exception.
   */
  static tooManyRequests(message: string = 'Too Many Requests'): HttpException {
    return new HttpException(429, message)
  }

  /**
   * Create a 500 Internal Server Error exception.
   */
  static internal(message: string = 'Internal Server Error'): HttpException {
    return new HttpException(500, message)
  }

  /**
   * Create a 501 Not Implemented exception.
   */
  static notImplemented(message: string = 'Not Implemented'): HttpException {
    return new HttpException(501, message)
  }

  /**
   * Create a 502 Bad Gateway exception.
   */
  static badGateway(message: string = 'Bad Gateway'): HttpException {
    return new HttpException(502, message)
  }

  /**
   * Create a 503 Service Unavailable exception.
   */
  static serviceUnavailable(message: string = 'Service Unavailable'): HttpException {
    return new HttpException(503, message)
  }

  /**
   * Create a 504 Gateway Timeout exception.
   */
  static gatewayTimeout(message: string = 'Gateway Timeout'): HttpException {
    return new HttpException(504, message)
  }

  /**
   * Check if an error is an HTTP exception.
   */
  static isHttpException(error: unknown): error is HttpException {
    return error instanceof HttpException
      || (
        typeof error === 'object'
        && error !== null
        && 'statusCode' in error
        && typeof (error as { statusCode?: unknown }).statusCode === 'number'
        && 'toResponse' in error
        && typeof (error as { toResponse?: unknown }).toResponse === 'function'
      )
  }
}

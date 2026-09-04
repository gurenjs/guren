import type { ErrorResponse } from './types'

/** Base HTTP exception class. */
export class HttpException extends Error {
  readonly statusCode: number

  readonly errors?: Record<string, string[]>

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

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
  }

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

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      statusCode: this.statusCode,
      errors: this.errors,
      data: this.data,
    }
  }

  static badRequest(message: string = 'Bad Request'): HttpException {
    return new HttpException(400, message)
  }

  static unauthorized(message: string = 'Unauthorized'): HttpException {
    return new HttpException(401, message)
  }

  static forbidden(message: string = 'Forbidden'): HttpException {
    return new HttpException(403, message)
  }

  static notFound(message: string = 'Not Found'): HttpException {
    return new HttpException(404, message)
  }

  static methodNotAllowed(message: string = 'Method Not Allowed'): HttpException {
    return new HttpException(405, message)
  }

  static conflict(message: string = 'Conflict'): HttpException {
    return new HttpException(409, message)
  }

  static gone(message: string = 'Gone'): HttpException {
    return new HttpException(410, message)
  }

  static unprocessable(
    message: string = 'Unprocessable Entity',
    errors?: Record<string, string[]>
  ): HttpException {
    return new HttpException(422, message, errors)
  }

  static tooManyRequests(message: string = 'Too Many Requests'): HttpException {
    return new HttpException(429, message)
  }

  static internal(message: string = 'Internal Server Error'): HttpException {
    return new HttpException(500, message)
  }

  static notImplemented(message: string = 'Not Implemented'): HttpException {
    return new HttpException(501, message)
  }

  static badGateway(message: string = 'Bad Gateway'): HttpException {
    return new HttpException(502, message)
  }

  static serviceUnavailable(message: string = 'Service Unavailable'): HttpException {
    return new HttpException(503, message)
  }

  static gatewayTimeout(message: string = 'Gateway Timeout'): HttpException {
    return new HttpException(504, message)
  }

  /** Duck-typed: an exception from another copy of the package still passes. */
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

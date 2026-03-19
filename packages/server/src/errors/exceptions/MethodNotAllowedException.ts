import { HttpException } from '../HttpException'

/**
 * Method Not Allowed exception.
 *
 * Thrown when an HTTP method is not allowed for a route.
 *
 * @example
 * ```typescript
 * throw new MethodNotAllowedException()
 * throw new MethodNotAllowedException('POST', ['GET', 'HEAD'])
 * ```
 */
export class MethodNotAllowedException extends HttpException {
  /**
   * The HTTP method that was attempted.
   */
  readonly method?: string

  /**
   * The allowed HTTP methods.
   */
  readonly allowedMethods?: string[]

  constructor(
    method?: string,
    allowedMethods?: string[],
    message?: string
  ) {
    const defaultMessage = method
      ? `Method ${method} is not allowed.`
      : 'Method Not Allowed'
    super(405, message ?? defaultMessage)
    this.name = 'MethodNotAllowedException'
    this.method = method
    this.allowedMethods = allowedMethods
  }

  /**
   * Get the Allow header value.
   */
  getAllowHeader(): string {
    return this.allowedMethods?.join(', ') ?? ''
  }

  /**
   * Create exception with method details.
   */
  static forMethod(
    method: string,
    allowedMethods: string[]
  ): MethodNotAllowedException {
    return new MethodNotAllowedException(
      method,
      allowedMethods,
      `Method ${method} not allowed. Allowed methods: ${allowedMethods.join(', ')}`
    )
  }
}

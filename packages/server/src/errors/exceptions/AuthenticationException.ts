import { HttpException } from '../HttpException'

/**
 * Authentication exception.
 *
 * Thrown when a user is not authenticated or credentials are invalid.
 *
 * @example
 * ```typescript
 * throw new AuthenticationException()
 * throw new AuthenticationException('Invalid token')
 * throw new AuthenticationException('Session expired', 'login')
 * ```
 */
export class AuthenticationException extends HttpException {
  /**
   * The guard that threw the exception.
   */
  readonly guard?: string

  /**
   * URL to redirect to for authentication.
   */
  readonly redirectTo?: string

  constructor(
    message: string = 'Unauthenticated.',
    guard?: string,
    redirectTo?: string
  ) {
    super(401, message)
    this.name = 'AuthenticationException'
    this.guard = guard
    this.redirectTo = redirectTo
  }

  /**
   * Create exception with redirect URL.
   */
  static withRedirect(redirectTo: string, message?: string): AuthenticationException {
    return new AuthenticationException(message, undefined, redirectTo)
  }

  /**
   * Create exception for a specific guard.
   */
  static forGuard(guard: string, message?: string): AuthenticationException {
    return new AuthenticationException(message, guard)
  }
}

import { HttpException } from '../HttpException'

/** 401: the user is not authenticated, or the credentials were invalid. */
export class AuthenticationException extends HttpException {
  /** The guard that threw. */
  readonly guard?: string

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

  static withRedirect(redirectTo: string, message?: string): AuthenticationException {
    return new AuthenticationException(message, undefined, redirectTo)
  }

  static forGuard(guard: string, message?: string): AuthenticationException {
    return new AuthenticationException(message, guard)
  }
}

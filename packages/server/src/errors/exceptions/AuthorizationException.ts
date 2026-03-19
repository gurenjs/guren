import { HttpException } from '../HttpException'

/**
 * Authorization exception.
 *
 * Thrown when a user is authenticated but not authorized to perform an action.
 *
 * @example
 * ```typescript
 * throw new AuthorizationException()
 * throw new AuthorizationException('You cannot edit this post')
 * throw new AuthorizationException('Access denied', 'edit', 'Post')
 * ```
 */
export class AuthorizationException extends HttpException {
  /**
   * The action that was attempted.
   */
  readonly action?: string

  /**
   * The resource that was being accessed.
   */
  readonly resource?: string

  constructor(
    message: string = 'This action is unauthorized.',
    action?: string,
    resource?: string
  ) {
    super(403, message)
    this.name = 'AuthorizationException'
    this.action = action
    this.resource = resource
  }

  /**
   * Create exception for a specific action and resource.
   */
  static forAction(action: string, resource?: string): AuthorizationException {
    const message = resource
      ? `You are not authorized to ${action} this ${resource}.`
      : `You are not authorized to ${action}.`
    return new AuthorizationException(message, action, resource)
  }

  /**
   * Deny access to a resource.
   */
  static deny(resource?: string): AuthorizationException {
    const message = resource
      ? `Access to ${resource} denied.`
      : 'Access denied.'
    return new AuthorizationException(message, 'access', resource)
  }
}

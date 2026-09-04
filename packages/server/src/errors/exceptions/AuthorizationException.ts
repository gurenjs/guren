import { HttpException } from '../HttpException'

/** 403: the user is authenticated but not allowed to perform the action. */
export class AuthorizationException extends HttpException {
  readonly action?: string

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

  static forAction(action: string, resource?: string): AuthorizationException {
    const message = resource
      ? `You are not authorized to ${action} this ${resource}.`
      : `You are not authorized to ${action}.`
    return new AuthorizationException(message, action, resource)
  }

  static deny(resource?: string): AuthorizationException {
    const message = resource
      ? `Access to ${resource} denied.`
      : 'Access denied.'
    return new AuthorizationException(message, 'access', resource)
  }
}

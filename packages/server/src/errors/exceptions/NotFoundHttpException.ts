import { HttpException } from '../HttpException'

/**
 * Not Found HTTP exception.
 *
 * Thrown when a requested resource cannot be found.
 *
 * @example
 * ```typescript
 * throw new NotFoundHttpException()
 * throw new NotFoundHttpException('User not found')
 * throw NotFoundHttpException.forModel('User', 123)
 * ```
 */
export class NotFoundHttpException extends HttpException {
  /**
   * The type of resource that was not found.
   */
  readonly resourceType?: string

  /**
   * The ID of the resource that was not found.
   */
  readonly resourceId?: string | number

  constructor(
    message: string = 'Not Found',
    resourceType?: string,
    resourceId?: string | number
  ) {
    super(404, message)
    this.name = 'NotFoundHttpException'
    this.resourceType = resourceType
    this.resourceId = resourceId
  }

  /**
   * Create exception for a model not found.
   */
  static forModel(
    model: string,
    id: string | number
  ): NotFoundHttpException {
    return new NotFoundHttpException(
      `${model} with ID ${id} not found.`,
      model,
      id
    )
  }

  /**
   * Create exception for a route not found.
   */
  static forRoute(path: string): NotFoundHttpException {
    return new NotFoundHttpException(`Route ${path} not found.`, 'Route')
  }

  /**
   * Create exception for a resource not found.
   */
  static forResource(resource: string): NotFoundHttpException {
    return new NotFoundHttpException(`${resource} not found.`, resource)
  }
}

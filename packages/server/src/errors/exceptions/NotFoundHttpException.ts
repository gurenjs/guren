import { HttpException, NOT_FOUND_MESSAGE } from '../HttpException'

/**
 * Set, non-enumerable, by the `for*()` constructors, whose message the framework
 * wrote from the record. Registry-keyed so a second copy of the package reads it;
 * no public field marks it, since the constructor takes a developer's message too.
 */
const COMPOSED_MESSAGE = Symbol.for('guren.notFound.composedMessage')

function composed(error: NotFoundHttpException): NotFoundHttpException {
  Object.defineProperty(error, COMPOSED_MESSAGE, { value: true })
  return error
}

/** Whether a `for*()` constructor wrote `error`'s message, which the exception handler replaces outside debug. */
export function hasComposedMessage(error: object): boolean {
  return (error as { [COMPOSED_MESSAGE]?: unknown })[COMPOSED_MESSAGE] === true
}

/** 404: the requested resource could not be found. */
export class NotFoundHttpException extends HttpException {
  readonly resourceType?: string

  readonly resourceId?: string | number

  constructor(
    message: string = NOT_FOUND_MESSAGE,
    resourceType?: string,
    resourceId?: string | number
  ) {
    super(404, message)
    this.name = 'NotFoundHttpException'
    this.resourceType = resourceType
    this.resourceId = resourceId
  }

  static forModel(
    model: string,
    id: string | number
  ): NotFoundHttpException {
    return composed(new NotFoundHttpException(
      `${model} with ID ${id} not found.`,
      model,
      id
    ))
  }

  static forRoute(path: string): NotFoundHttpException {
    return composed(new NotFoundHttpException(`Route ${path} not found.`, 'Route'))
  }

  static forResource(resource: string): NotFoundHttpException {
    return composed(new NotFoundHttpException(`${resource} not found.`, resource))
  }
}

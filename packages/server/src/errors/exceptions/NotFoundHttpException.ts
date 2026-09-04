import { HttpException } from '../HttpException'

/** 404: the requested resource could not be found. */
export class NotFoundHttpException extends HttpException {
  readonly resourceType?: string

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

  static forRoute(path: string): NotFoundHttpException {
    return new NotFoundHttpException(`Route ${path} not found.`, 'Route')
  }

  static forResource(resource: string): NotFoundHttpException {
    return new NotFoundHttpException(`${resource} not found.`, resource)
  }
}

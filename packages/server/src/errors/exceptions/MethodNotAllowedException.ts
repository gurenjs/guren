import { HttpException } from '../HttpException'

/** 405: the HTTP method is not allowed for the route. */
export class MethodNotAllowedException extends HttpException {
  readonly method?: string

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

  getAllowHeader(): string {
    return this.allowedMethods?.join(', ') ?? ''
  }

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

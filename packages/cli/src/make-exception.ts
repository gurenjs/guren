import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const EXCEPTIONS_DIR = 'app/Exceptions'

function exceptionTemplate(className: string, statusCode: number, defaultMessage: string): string {
  return `import { HttpException } from '@guren/server'

export class ${className} extends HttpException {
  constructor(message = '${defaultMessage}') {
    super(${statusCode}, message)
  }

  /**
   * Render the exception to a response.
   * Override this method to customize the error response.
   */
  // render(ctx: Context): Response {
  //   return ctx.json({
  //     message: this.message,
  //     code: '${className.replace(/Exception$/, '').toUpperCase()}',
  //   }, this.statusCode)
  // }

  /**
   * Report the exception.
   * Override this method to log or send the exception to external services.
   */
  // report(): void {
  //   console.error(this.message)
  // }
}
`
}

export interface MakeExceptionOptions extends WriterOptions {
  status?: number
  message?: string
}

export async function makeException(name: string, options: MakeExceptionOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: EXCEPTIONS_DIR,
    suffix: 'Exception',
    template: ({ normalizedName }) => {
      const statusCode = options.status ?? 500
      const defaultMessage = options.message ?? 'An error occurred'
      return exceptionTemplate(normalizedName, statusCode, defaultMessage)
    },
  }, options)
}

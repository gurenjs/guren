import { ServiceProvider } from '../container/ServiceProvider'
import { createExceptionHandler } from '../errors'

/**
 * Binds the ExceptionHandler as a singleton in the container.
 */
export class ErrorServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('exception.handler', () => createExceptionHandler())
  }
}

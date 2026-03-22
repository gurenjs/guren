import { ServiceProvider } from '../container/ServiceProvider'
import { createExceptionHandler } from '../errors'
import type { ExceptionHandler } from '../errors/ExceptionHandler'
import type { Hono } from 'hono'

/**
 * Binds the ExceptionHandler as a singleton in the container
 * and attaches it as global error-handling middleware.
 */
export class ErrorServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('exception.handler', () => createExceptionHandler())
  }

  boot(): void {
    const hono = this.container.make<Hono>('hono')
    const handler = this.container.make<ExceptionHandler>('exception.handler')
    hono.onError((error, ctx) => handler.handle(error, ctx))
  }
}

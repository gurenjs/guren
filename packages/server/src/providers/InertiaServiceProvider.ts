import { ServiceProvider } from '../container/ServiceProvider'
import { inertia } from '../mvc/inertia/InertiaEngine'
import { ViewEngine } from '../mvc/ViewEngine'
import { ValidationException } from '../errors/exceptions/ValidationException'
import { getInertiaSharedPropsResolver, setInertiaSharedProps } from '../mvc/inertia/shared'
import { getSessionFromContext } from '../http/middleware/session'
import type { ExceptionHandler } from '../errors/ExceptionHandler'
import type { Context } from 'hono'

/**
 * Registers the Inertia view engine and wires up validation error handling
 * for Inertia requests (Laravel-style automatic redirect with flashed errors).
 */
export class InertiaServiceProvider extends ServiceProvider {
  register(): void {
    if (!ViewEngine.has('inertia')) {
      ViewEngine.register('inertia', inertia)
    }
  }

  boot(): void {
    this.registerValidationRenderer()
    this.registerSharedErrors()
  }

  /**
   * Register a custom renderer for ValidationException on Inertia requests.
   * Non-Inertia requests fall through to the default JSON 422 response.
   */
  private registerValidationRenderer(): void {
    let handler: ExceptionHandler
    try {
      handler = this.container.make<ExceptionHandler>('exception.handler')
    } catch {
      // ErrorServiceProvider not registered — skip
      return
    }

    handler.render(ValidationException, (error, ctx) => {
      const isInertia = ctx.req.header('X-Inertia')
      if (!isInertia) {
        // Non-Inertia: return default JSON 422
        return ctx.json(
          {
            message: error.message,
            errors: error.errors,
          },
          422,
        )
      }

      // Inertia: flash errors to session and redirect back
      const session = getSessionFromContext(ctx)
      if (session) {
        const flattened: Record<string, string> = {}
        for (const [key, messages] of Object.entries(error.errors ?? {})) {
          flattened[key] = messages[0] ?? ''
        }
        session.flash('errors', flattened)
      }

      const referer = ctx.req.header('Referer') ?? '/'
      return new Response(null, {
        status: 303,
        headers: { Location: referer },
      })
    })
  }

  /**
   * Wrap existing shared props resolver to auto-inject flashed `errors`.
   */
  private registerSharedErrors(): void {
    const previous = getInertiaSharedPropsResolver()

    setInertiaSharedProps(async (ctx: Context) => {
      const prev = previous ? await previous(ctx) : {}
      const session = getSessionFromContext(ctx)
      const errors = session?.getFlash<Record<string, string>>('errors')
      return {
        ...prev,
        ...(errors && Object.keys(errors).length > 0 ? { errors } : {}),
      }
    })
  }
}

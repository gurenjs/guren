import { ServiceProvider } from '../container/ServiceProvider'
import { inertia } from '../mvc/inertia/InertiaEngine'
import { ViewEngine } from '../mvc/ViewEngine'
import { ValidationException } from '../errors/exceptions/ValidationException'
import { shareInertiaProps } from '../mvc/inertia/shared'
import { getSessionFromContext } from '../http/middleware/session'
import {
  createValidationErrorsCookieCleanup,
  readValidationErrorsCookie,
  validationErrorsSetCookie,
} from '../http/middleware/validation-errors-cookie'
import type { ExceptionHandler } from '../errors/ExceptionHandler'
import type { Context, Hono } from 'hono'

/**
 * Registers the Inertia view engine and wires up validation error handling
 * for Inertia requests (Laravel-style automatic redirect with flashed errors).
 */
export class InertiaServiceProvider extends ServiceProvider {
  register(): void {
    if (!ViewEngine.has('inertia')) {
      ViewEngine.register('inertia', inertia)
    }

    // Sessionless apps flash validation errors through a cookie instead of
    // the session (see the renderer below); this expires that cookie on the
    // render that consumed it.
    let hono: Hono
    try {
      hono = this.container.make<Hono>('hono')
    } catch {
      // Bare container without an HTTP app — the cookie then relies on its
      // Max-Age alone.
      return
    }

    hono.use('*', createValidationErrorsCookieCleanup())
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

      // Inertia: flash errors and redirect back
      const flattened: Record<string, string> = {}
      for (const [key, messages] of Object.entries(error.errors ?? {})) {
        flattened[key] = messages[0] ?? ''
      }

      const referer = ctx.req.header('Referer') ?? '/'
      const headers: Record<string, string> = { Location: referer }

      const session = getSessionFromContext(ctx)
      if (session) {
        session.flash('errors', flattened)
      } else {
        // Sessions only mount with `createApp({ auth })`, so a fresh scaffold
        // has none — and errors dropped here would make every validation
        // failure look like "the form did nothing". Flash them through a
        // short-lived cookie instead.
        headers['Set-Cookie'] = validationErrorsSetCookie(flattened)
      }

      return new Response(null, {
        status: 303,
        headers,
      })
    })
  }

  /**
   * Auto-inject flashed `errors` into shared props. Scoped to this app's
   * container so a second Application booted in the same process keeps its
   * own registrations.
   */
  private registerSharedErrors(): void {
    shareInertiaProps(async (ctx: Context) => {
      const session = getSessionFromContext(ctx)
      if (session) {
        const errors = session.getFlash<Record<string, string>>('errors')
        return errors && Object.keys(errors).length > 0 ? { errors } : {}
      }

      const errors = readValidationErrorsCookie(ctx)
      return errors ? { errors } : {}
    }, this.container)
  }
}

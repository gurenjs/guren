import { ServiceProvider } from '../container/ServiceProvider'
import { inertia } from '../mvc/inertia/InertiaEngine'
import { ViewEngine } from '../mvc/ViewEngine'
import { ValidationException } from '../errors/exceptions/ValidationException'
import { shareInertiaProps } from '../mvc/inertia/shared'
import { always } from '../mvc/inertia/props'
import { getSessionFromContext } from '../http/middleware/session'
import { sameHostRefererPath } from '../http/middleware/redirect-safety'
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

  /** ValidationException on Inertia requests; others fall through to JSON 422. */
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
        return ctx.json(
          {
            message: error.message,
            errors: error.errors,
          },
          422,
        )
      }

      const flattened: Record<string, string> = {}
      for (const [key, messages] of Object.entries(error.errors ?? {})) {
        flattened[key] = messages[0] ?? ''
      }

      const location = sameHostRefererPath(ctx.req.header('Referer'), ctx.req.url, this.refererHosts(ctx.req.url))
      const headers: Record<string, string> = { Location: location }

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
   * The request's host, and the one `APP_URL` names (what `config/http.ts`'s host
   * authorization and the auth scaffold's links key on): a proxy that does not
   * forward `Host` hands the app its upstream address instead. `X-Forwarded-Host`
   * is not read, since no app-wide trusted-proxy setting says when it is genuine.
   */
  private refererHosts(requestUrl: string): string[] {
    const hosts = [new URL(requestUrl).host]
    const env = this.container.makeOptional<Readonly<Record<string, unknown>>>('env')
    const appUrl = env?.APP_URL ?? (typeof process === 'undefined' ? undefined : process.env.APP_URL)
    if (typeof appUrl !== 'string' || appUrl.trim() === '') return hosts

    try {
      hosts.push(new URL(appUrl.trim()).host)
    } catch {
      // An unparsable APP_URL names no host; config/env.ts reports it at boot.
    }
    return hosts
  }

  /**
   * Auto-inject flashed `errors` into shared props. Scoped to this app's
   * container so a second Application booted in the same process keeps its
   * own registrations.
   */
  private registerSharedErrors(): void {
    // Always: the flash is consumed by this request whether or not a partial
    // reload's `only` list names `errors`, so a dropped copy would be lost.
    shareInertiaProps(async (ctx: Context) => {
      const session = getSessionFromContext(ctx)
      if (session) {
        const errors = session.getFlash<Record<string, string>>('errors')
        return errors && Object.keys(errors).length > 0 ? { errors: always(errors) } : {}
      }

      const errors = readValidationErrorsCookie(ctx)
      return errors ? { errors: always(errors) } : {}
    }, this.container)
  }
}

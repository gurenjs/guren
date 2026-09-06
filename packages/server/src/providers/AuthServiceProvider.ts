import { ServiceProvider } from '../container/ServiceProvider'
import { attachAuthContext } from '../http/middleware/auth'
import { createSessionMiddleware, type CreateSessionMiddlewareOptions } from '../http/middleware/session'
import type { SessionManager } from '../http/middleware/session-manager'
import type { MiddlewareHandler } from 'hono'
import { createCsrfMiddleware } from '../http/middleware/csrf'
import { SessionGuard } from '../auth/SessionGuard'
import type { GuardFactory } from '../auth/types'
import type { Application, AuthPluginOptions } from '../http/Application'
import type { AuthManager } from '../auth'

const DEFAULT_GUARD = 'web'
const DEFAULT_PROVIDER = 'users'

const DOUBLE_SESSION_CONFIG =
  'Sessions are configured twice: `auth.sessionOptions.store` in createApp() and a "session" '
  + 'container binding (SessionProvider). Keep one — the manager, or the explicit store.'

function defaultCookieSecure(): boolean {
  return typeof process !== 'undefined' ? process.env.NODE_ENV === 'production' : true
}

/** Sets up authentication guards, session middleware, and auth context. */
export class AuthServiceProvider extends ServiceProvider {
  private attachedSession = false

  register(): void {
    const app = this.container.make<Application>('app')
    const auth = this.container.make<AuthManager>('auth')

    if (!auth.guardNames().length) {
      auth.registerGuard(DEFAULT_GUARD, createDefaultGuardFactory(DEFAULT_PROVIDER))
      auth.setDefaultGuard(DEFAULT_GUARD)
    }

    const authOptions: AuthPluginOptions = app.authOptions ?? {}
    const shouldAttachSession = authOptions.autoSession !== false && !app.hasAutoSessionAttached()

    if (shouldAttachSession) {
      // Built on the first request, not here: an app's SessionProvider binds
      // `session` in its own register(), which runs after this one, and the
      // stores it declares may need a Workers binding no request has carried
      // yet (RFC 0020 §1). The wrapper keeps the middleware's place in the
      // chain, ahead of CSRF, which reads the session it attaches.
      let middleware: MiddlewareHandler | undefined
      app.use('*', (ctx, next) => {
        middleware ??= createSessionMiddleware(this.sessionMiddlewareOptions())
        return middleware(ctx, next)
      })
      app.markAutoSessionAttached()
      this.attachedSession = true

      // Auto-register CSRF protection when session is enabled (secure by default)
      if (authOptions.autoCsrf !== false) {
        const csrfOptions = authOptions.csrfOptions ?? {}
        // The endpoint registry stays out of the spread: inside it, an app's
        // `csrfOptions` could name paths of its own or drop the declared ones.
        app.use('*', createCsrfMiddleware({
          cookieOptions: {
            secure: typeof process !== 'undefined' ? process.env.NODE_ENV === 'production' : true,
          },
          ...csrfOptions,
        }, () => app.getCookielessAuthPaths()))
      }
    }

    // Attach auth context at the end of register() so it runs after session/CSRF
    // middleware. When autoSession: false, the user is responsible for mounting
    // session middleware before AuthServiceProvider is registered.
    app.use('*', attachAuthContext((ctx) => auth.createAuthContext(ctx)))
  }

  /**
   * Every provider has registered by now, so this is the earliest point the
   * double configuration is knowable; failing the boot beats a 500 on the
   * first request.
   */
  boot(): void {
    if (this.attachedSession) {
      this.sessionMiddlewareOptions()
    }
  }

  /**
   * The manager's cookie/TTL settings are the base and `auth.sessionOptions`
   * overrides them field by field, which is where existing apps already put
   * `cookieSecure`. The store comes from exactly one of the two.
   */
  private sessionMiddlewareOptions(): CreateSessionMiddlewareOptions {
    const app = this.container.make<Application>('app')
    const explicit: CreateSessionMiddlewareOptions = app.authOptions?.sessionOptions ?? {}
    const manager = this.container.has('session') ? this.container.make<SessionManager>('session') : undefined

    if (manager && explicit.store) {
      throw new Error(DOUBLE_SESSION_CONFIG)
    }

    return {
      cookieSecure: defaultCookieSecure(),
      ...manager?.options,
      ...explicit,
      ...(manager && !explicit.store ? { store: () => manager.store() } : {}),
    }
  }
}

function createDefaultGuardFactory(providerName: string): GuardFactory {
  return ({ session, manager }) => {
    const provider = manager.getProvider(providerName)
    return new SessionGuard({
      provider,
      session,
    })
  }
}

import type { MiddlewareHandler } from 'hono'
import { ServiceProvider } from '../container/ServiceProvider'
import { attachAuthContext } from '../http/middleware/auth'
import { createSessionMiddleware, type CreateSessionMiddlewareOptions } from '../http/middleware/session'
import type { SessionManager } from '../http/middleware/session-manager'
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

/**
 * Sets up authentication guards, session middleware, and auth context. The
 * session store may come from a `session` container binding (RFC 0020 §1),
 * which an app's SessionProvider must make in `register()`: the middleware is
 * built in `boot()`, before any user provider's own boot runs.
 */
export class AuthServiceProvider extends ServiceProvider {
  private app!: Application
  private attachedSession = false
  private sessionMiddleware: MiddlewareHandler | undefined

  register(): void {
    const app = this.container.make<Application>('app')
    this.app = app
    const auth = this.container.make<AuthManager>('auth')

    if (!auth.guardNames().length) {
      auth.registerGuard(DEFAULT_GUARD, createDefaultGuardFactory(DEFAULT_PROVIDER))
      auth.setDefaultGuard(DEFAULT_GUARD)
    }

    const authOptions: AuthPluginOptions = app.authOptions ?? {}
    const shouldAttachSession = authOptions.autoSession !== false && !app.hasAutoSessionAttached()

    if (shouldAttachSession) {
      // A placeholder keeps the middleware's place in the chain, ahead of CSRF,
      // which reads the session it attaches; boot() fills it in once the app's
      // SessionProvider has registered. The `??=` covers an app that never boots.
      app.use('*', (ctx, next) => (this.sessionMiddleware ??= this.buildSessionMiddleware())(ctx, next))
      app.markAutoSessionAttached()
      this.attachedSession = true

      // Auto-register CSRF protection when session is enabled (secure by default)
      if (authOptions.autoCsrf !== false) {
        const csrfOptions = authOptions.csrfOptions ?? {}
        // The endpoint registry stays out of the spread: inside it, an app's
        // `csrfOptions` could name paths of its own or drop the declared ones.
        app.use('*', createCsrfMiddleware(csrfOptions, () => app.getCookielessAuthPaths()))
      }
    }

    // Attach auth context at the end of register() so it runs after session/CSRF
    // middleware. When autoSession: false, the user is responsible for mounting
    // session middleware before AuthServiceProvider is registered.
    app.use('*', attachAuthContext((ctx) => auth.createAuthContext(ctx)))
  }

  /**
   * Every provider has registered, so the manager, a double configuration, a
   * missing driver, and a bad APP_KEY (the cookie signer) all fail here, not
   * on the first request. Only the store itself stays lazy. A *deferred*
   * SessionProvider activates on a make() after boot, so that one shape keeps
   * the first-request build.
   */
  boot(): void {
    if (!this.attachedSession || this.app.isDeferredService('session')) {
      return
    }
    this.sessionMiddleware = this.buildSessionMiddleware()
  }

  private buildSessionMiddleware(): MiddlewareHandler {
    const explicit: CreateSessionMiddlewareOptions = this.app.authOptions?.sessionOptions ?? {}
    const manager = this.container.makeOptional<SessionManager>('session')

    if (manager && explicit.store) {
      throw new Error(DOUBLE_SESSION_CONFIG)
    }
    manager?.assertDriverRegistered()

    // The manager's cookie/TTL settings are the base; `auth.sessionOptions`
    // overrides them field by field. The middleware supplies every other default.
    return createSessionMiddleware({
      ...manager?.options,
      ...explicit,
      ...(manager && { store: () => manager.store() }),
    })
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

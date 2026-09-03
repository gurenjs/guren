import { ServiceProvider } from '../container/ServiceProvider'
import { attachAuthContext } from '../http/middleware/auth'
import { createSessionMiddleware, type CreateSessionMiddlewareOptions } from '../http/middleware/session'
import { createCsrfMiddleware } from '../http/middleware/csrf'
import { SessionGuard } from '../auth/SessionGuard'
import type { GuardFactory } from '../auth/types'
import type { Application, AuthPluginOptions } from '../http/Application'
import type { AuthManager } from '../auth'

const DEFAULT_GUARD = 'web'
const DEFAULT_PROVIDER = 'users'

/**
 * Sets up authentication guards, session middleware, and auth context.
 */
export class AuthServiceProvider extends ServiceProvider {
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
      const sessionOptions: CreateSessionMiddlewareOptions = {
        cookieSecure: typeof process !== 'undefined' ? process.env.NODE_ENV === 'production' : true,
        ...authOptions.sessionOptions,
      }

      app.use('*', createSessionMiddleware(sessionOptions))
      app.markAutoSessionAttached()

      // Auto-register CSRF protection when session is enabled (secure by default)
      if (authOptions.autoCsrf !== false) {
        const csrfOptions = authOptions.csrfOptions ?? {}
        app.use('*', createCsrfMiddleware({
          cookieOptions: {
            secure: typeof process !== 'undefined' ? process.env.NODE_ENV === 'production' : true,
          },
          ...csrfOptions,
        }))
      }
    }

    // Attach auth context at the end of register() so it runs after session/CSRF
    // middleware. When autoSession: false, the user is responsible for mounting
    // session middleware before AuthServiceProvider is registered.
    app.use('*', attachAuthContext((ctx) => auth.createAuthContext(ctx)))
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

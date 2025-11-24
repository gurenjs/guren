import type { Provider, ProviderConstructor } from '../Provider'
import type { ApplicationContext } from '../ApplicationContext'
import { attachAuthContext } from '../../http/middleware/auth'
import { createSessionMiddleware, type CreateSessionMiddlewareOptions } from '../../http/middleware/session'
import { SessionGuard } from '../../auth/SessionGuard'
import type { GuardFactory } from '../../auth/types'

const DEFAULT_GUARD = 'web'
const DEFAULT_PROVIDER = 'users'

export class AuthServiceProvider implements Provider {
  register(context: ApplicationContext): void {
    const auth = context.auth
    const { app } = context

    if (!auth.guardNames().length) {
      auth.registerGuard(DEFAULT_GUARD, createDefaultGuardFactory(DEFAULT_PROVIDER))
      auth.setDefaultGuard(DEFAULT_GUARD)
    }

    const authOptions = app.authOptions ?? {}
    const shouldAttachSession = authOptions.autoSession !== false && !app.hasAutoSessionAttached()

    if (shouldAttachSession) {
      const sessionOptions: CreateSessionMiddlewareOptions = {
        cookieSecure: typeof process !== 'undefined' ? process.env.NODE_ENV === 'production' : true,
        ...authOptions.sessionOptions,
      }

      app.use('*', createSessionMiddleware(sessionOptions))
      app.markAutoSessionAttached()
    }

    app.use('*', attachAuthContext((ctx) => auth.createAuthContext(ctx)))
  }
}

function createDefaultGuardFactory(providerName: string): GuardFactory {
  return ({ ctx, session, manager }) => {
    const provider = manager.getProvider(providerName)
    return new SessionGuard({
      provider,
      session,
    })
  }
}

export const AuthServiceProviderConstructor: ProviderConstructor = AuthServiceProvider

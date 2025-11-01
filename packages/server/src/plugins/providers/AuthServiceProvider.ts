import type { Provider, ProviderConstructor } from '../Provider'
import type { ApplicationContext } from '../ApplicationContext'
import { attachAuthContext } from '../../http/middleware/auth'
import { SessionGuard } from '../../auth/SessionGuard'
import type { GuardFactory } from '../../auth/types'

const DEFAULT_GUARD = 'web'
const DEFAULT_PROVIDER = 'users'

export class AuthServiceProvider implements Provider {
  register(context: ApplicationContext): void {
    const auth = context.auth

    if (!auth.guardNames().length) {
      auth.registerGuard(DEFAULT_GUARD, createDefaultGuardFactory(DEFAULT_PROVIDER))
      auth.setDefaultGuard(DEFAULT_GUARD)
    }
  }

  boot(context: ApplicationContext): void {
    const { app, auth } = context

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

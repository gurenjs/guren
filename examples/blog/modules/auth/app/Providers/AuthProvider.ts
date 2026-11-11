import { ServiceProvider } from '@guren/core'
import type { AuthManager } from '@guren/core'
import { User } from '../../../../app/Models/User.js'
import { PasswordBoundSessionGuard } from '../Auth/PasswordBoundSessionGuard.js'

export default class AuthProvider extends ServiceProvider {
  register(): void {
    const auth = this.container.make<AuthManager>('auth')
    auth.useModel(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    })
    // Replaces the plain SessionGuard useModel() registers under 'web', so a
    // password reset or change signs out the sessions opened before it.
    auth.registerGuard('web', ({ session, manager }) => new PasswordBoundSessionGuard({
      provider: manager.getProvider('users'),
      session,
      passwordColumn: 'passwordHash',
    }))
    // AuthServiceProvider auto-registers CSRF middleware when autoSession is on.
  }
}

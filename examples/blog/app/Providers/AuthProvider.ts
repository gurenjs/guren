import { ServiceProvider } from '@guren/core'
import type { AuthManager } from '@guren/core'
import { User } from '../Models/User.js'

export default class AuthProvider extends ServiceProvider {
  register(): void {
    const auth = this.container.make<AuthManager>('auth')
    auth.useModel(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    })
    // CSRF middleware is now auto-registered by AuthServiceProvider
    // when autoSession is enabled (secure by default).
  }
}

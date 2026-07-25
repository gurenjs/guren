import { ServiceProvider } from '@guren/core'
import type { AuthManager } from '@guren/core'
import { User } from '../Models/User.js'

export default class AuthProvider extends ServiceProvider {
  register(): void {
    const auth = this.container.make<AuthManager>('auth')
    // passwordColumn stays configured even though accounts are passwordless:
    // the guard uses it to reject password logins for hash-less OAuth users.
    auth.useModel(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
    })
  }
}

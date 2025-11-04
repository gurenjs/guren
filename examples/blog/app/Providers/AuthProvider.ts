import type { ApplicationContext, Provider } from '@guren/core'
import { ModelUserProvider } from '@guren/core'
import { User } from '../Models/User.js'

export default class AuthProvider implements Provider {
  register(context: ApplicationContext): void {
    context.auth.registerProvider('users', () => new ModelUserProvider(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    }))
  }

  boot(): void {}
}

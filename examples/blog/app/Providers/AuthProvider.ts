import type { ApplicationContext, Provider } from '@guren/core'
import { ModelUserProvider, ScryptHasher } from '@guren/core'
import { User } from '../Models/User'

export default class AuthProvider implements Provider {
  register(context: ApplicationContext): void {
    context.auth.registerProvider('users', () => new ModelUserProvider(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
      hasher: new ScryptHasher(),
    }))
  }

  boot(): void {}
}

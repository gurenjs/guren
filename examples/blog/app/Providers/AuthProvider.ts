import { ServiceProvider, createCsrfMiddleware } from '@guren/core'
import type { AuthManager, Application } from '@guren/core'
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

    const app = this.container.make<Application>('app')
    app.use('*', createCsrfMiddleware({
      cookieOptions: {
        secure: process.env.NODE_ENV === 'production',
      },
    }))
  }
}

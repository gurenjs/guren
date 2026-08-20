import { ServiceProvider, shareInertiaProps, AUTH_CONTEXT_KEY } from '@guren/core'
import type { AuthContext, AuthManager } from '@guren/core'
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
  }

  boot(): void {
    // Nothing shares the signed-in user with the frontend by default, so every
    // page would render as a guest. Layout.tsx reads this to choose between
    // "Sign in" and the Log out control.
    //
    // shareInertiaProps merges over resolvers registered earlier instead of
    // replacing them, so the framework's flashed `errors` still come through.
    // Passing this.container scopes the props to this app.
    shareInertiaProps(async (ctx) => {
      const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
      return { auth: { user: await auth?.user() } }
    }, this.container)
  }
}

import { Controller, ValidationException } from '@guren/core'
import { LoginSchema } from '../../Validators/LoginValidator.js'
import { UserLoggedIn } from '../../../Events/UserLoggedIn.js'
import type { UserRecord } from '../../../Models/User.js'
import { pages } from '@/.guren/pages.gen'

export default class LoginController extends Controller {
  async show(): Promise<Response> {
    const email = this.request.query('email') ?? ''
    return this.inertia(pages.auth.Login, { email }, { title: 'Login | Guren Blog' })
  }

  async store(): Promise<Response> {
    // validateBody throws ValidationException on failure →
    // InertiaServiceProvider catches it, flashes errors to session, and redirects back (303).
    // Inertia's useForm() preserves client-side input state across the redirect.
    const { email, password, remember } = await this.validateBody(LoginSchema)

    const session = this.auth.session()
    session?.regenerate()

    const authenticated = await this.auth.attempt({ email, password }, remember)

    if (!authenticated) {
      throw ValidationException.withMessages({ message: 'Invalid credentials.' })
    }

    // Emit UserLoggedIn event
    const user = (await this.auth.user()) as UserRecord | null
    if (user) {
      const ipAddress = this.request.header('x-forwarded-for') ?? this.request.header('x-real-ip') ?? null
      const events = this.make('events')
      await events.emit(new UserLoggedIn(user, ipAddress))
    }

    return this.redirect('/dashboard')
  }

  async destroy(): Promise<Response> {
    await this.auth.logout()
    const session = this.auth.session()
    session?.invalidate()
    return this.redirect('/')
  }
}

import { Controller, parseRequestPayload, formatValidationErrors } from '@guren/server'
import { LoginSchema } from '../../Validators/LoginValidator.js'
import { getEventManager } from '../../../Providers/EventServiceProvider.js'
import { UserLoggedIn } from '../../../Events/UserLoggedIn.js'
import type { UserRecord } from '../../../Models/User.js'

export default class LoginController extends Controller {
  async show(): Promise<Response> {
    const email = this.request.query('email') ?? ''
    return this.inertia('auth/Login', { email }, { url: this.request.path, title: 'Login | Guren Blog' })
  }

  async store(): Promise<Response> {
    const rawPayload = await parseRequestPayload(this.ctx)
    const result = LoginSchema.safeParse(rawPayload)

    if (!result.success) {
      return this.json({ errors: formatValidationErrors(result.error) }, { status: 422 })
    }

    const { email, password, remember } = result.data

    const session = this.auth.session()
    session?.regenerate()

    const authenticated = await this.auth.attempt({ email, password }, remember)

    if (!authenticated) {
      return this.json({ errors: { message: 'Invalid credentials.' } }, { status: 422 })
    }

    // Emit UserLoggedIn event
    const user = await this.auth.user() as UserRecord | null
    if (user) {
      const ipAddress = this.request.header('x-forwarded-for') ?? this.request.header('x-real-ip') ?? null
      const events = getEventManager()
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

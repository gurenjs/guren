import { Controller, parseRequestPayload, formatValidationErrors } from '@guren/server'
import { LoginSchema } from '../../Validators/LoginValidator.js'

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

    return this.redirect('/dashboard')
  }

  async destroy(): Promise<Response> {
    await this.auth.logout()
    const session = this.auth.session()
    session?.invalidate()
    return this.redirect('/')
  }
}

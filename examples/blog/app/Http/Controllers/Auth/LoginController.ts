import type { Context } from '@guren/core'
import { parseRequestPayload, formatValidationErrors } from '@guren/core'
import Controller from '../Controller.js'
import { LoginSchema } from '../../Validators/LoginValidator.js'

export default class LoginController extends Controller {
  async show(ctx: Context): Promise<Response> {
    return this.inertiaWithAuth('auth/Login', { email: ctx.req.query('email') ?? '' }, { url: ctx.req.path, title: 'Login | Guren Blog' })
  }

  async store(ctx: Context): Promise<Response> {
    const rawPayload = await parseRequestPayload(ctx)
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

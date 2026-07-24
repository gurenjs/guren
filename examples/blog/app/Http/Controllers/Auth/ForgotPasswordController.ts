import { Controller, createPasswordResetToken, buildPasswordResetUrl } from '@guren/core'
import { ForgotPasswordSchema } from '../../Validators/ForgotPasswordValidator.js'
import { User } from '../../../Models/User.js'
import { passwordResetStore } from '../../../Auth/PasswordResetStore.js'
import { sendPasswordResetMail } from '../../../Mail/PasswordResetMail.js'
import { pages } from '@/.guren/pages.gen'

const STATUS_MESSAGE = "If an account exists for that email, we've sent a password reset link."

export default class ForgotPasswordController extends Controller {
  async show(): Promise<Response> {
    return this.inertia(pages.auth.ForgotPassword, {}, { url: this.request.path, title: 'Forgot password | Guren Blog' })
  }

  async store(): Promise<Response> {
    const { email } = await this.validateBody(ForgotPasswordSchema)

    // Always respond with the same status message whether or not the
    // account exists, to avoid leaking which emails are registered.
    const [user] = await User.where({ email })
    if (user) {
      const { token } = await createPasswordResetToken(email, passwordResetStore)
      const resetUrl = buildPasswordResetUrl(`${new URL(this.request.url).origin}/reset-password`, token, email)
      await sendPasswordResetMail(this.make('mail'), email, resetUrl)
    }

    return this.inertia(pages.auth.ForgotPassword, { status: STATUS_MESSAGE }, {
      url: this.request.path,
      title: 'Forgot password | Guren Blog',
    })
  }
}

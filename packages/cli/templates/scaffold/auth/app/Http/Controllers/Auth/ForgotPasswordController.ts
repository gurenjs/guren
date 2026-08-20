import { Controller, createPasswordResetToken, buildPasswordResetUrl } from '@guren/core'
import { ForgotPasswordSchema } from '../../Validators/ForgotPasswordValidator.js'
import { User } from '../../../Models/User.js'
import { passwordResetStore } from '../../../Auth/PasswordResetStore.js'
import { appUrl } from '../../../Auth/AppUrl.js'
import { sendPasswordResetMail } from '../../../Mail/PasswordResetMail.js'
import { pages } from '@/.guren/pages.gen'

const STATUS_MESSAGE = "If an account exists for that email, we've sent a password reset link."

export default class ForgotPasswordController extends Controller {
  async show(): Promise<Response> {
    return this.inertia(pages.auth.ForgotPassword, {}, { title: 'Forgot password' })
  }

  async store(): Promise<Response> {
    const { email } = await this.validateBody(ForgotPasswordSchema)

    // Resolved before the lookup on purpose: a misconfigured APP_URL throws,
    // and throwing only for addresses that turned out to exist would answer
    // the question the generic status message below refuses to.
    const resetBaseUrl = `${appUrl(this.request)}/reset-password`

    // Always respond with the same status message whether or not the
    // account exists, to avoid leaking which emails are registered. The
    // mail send is deliberately not awaited: the transport round-trip only
    // happens for known accounts, so awaiting it would let response timing
    // (or a transport failure) reveal which emails exist.
    const [user] = await User.where({ email })
    if (user) {
      const { token } = await createPasswordResetToken(email, passwordResetStore)
      const resetUrl = buildPasswordResetUrl(resetBaseUrl, token, email)
      void sendPasswordResetMail(this.make('mail'), email, resetUrl).catch((error) => {
        console.error('Failed to send password reset email:', error)
      })
    }

    return this.inertia(pages.auth.ForgotPassword, { status: STATUS_MESSAGE }, { title: 'Forgot password' })
  }
}

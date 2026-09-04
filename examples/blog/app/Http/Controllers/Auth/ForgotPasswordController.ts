import { Controller, createPasswordResetToken, buildPasswordResetUrl } from '@guren/core'
import { ForgotPasswordSchema } from '../../Validators/ForgotPasswordValidator.js'
import { User } from '../../../Models/User.js'
import { passwordResetStore } from '../../../Auth/PasswordResetStore.js'
import { appUrl } from '../../../Auth/AppUrl.js'
import { SendPasswordResetEmailJob } from '../../../Jobs/SendPasswordResetEmailJob.js'
import { pages } from '@/.guren/pages.gen'

const STATUS_MESSAGE = "If an account exists for that email, we've sent a password reset link."

export default class ForgotPasswordController extends Controller {
  async show(): Promise<Response> {
    return this.inertia(pages.auth.ForgotPassword, {}, { title: 'Forgot password | Guren Blog' })
  }

  async store(): Promise<Response> {
    const { email } = await this.validateBody(ForgotPasswordSchema)

    // Resolved before the lookup: a misconfigured APP_URL throws, and throwing
    // only for addresses that exist would answer the question hidden below.
    const resetBaseUrl = `${appUrl(this.request)}/reset-password`

    // One status message whether or not the account exists, so registered
    // emails do not leak. The mail is queued rather than awaited, so the slow
    // transport round-trip is not a timing side-channel either.
    const [user] = await User.where({ email })
    if (user) {
      const { token } = await createPasswordResetToken(email, passwordResetStore)
      const resetUrl = buildPasswordResetUrl(resetBaseUrl, token, email)
      await SendPasswordResetEmailJob.dispatch({ email, resetUrl })
    }

    return this.inertia(pages.auth.ForgotPassword, { status: STATUS_MESSAGE }, { title: 'Forgot password | Guren Blog' })
  }
}

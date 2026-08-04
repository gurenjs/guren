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
    return this.inertia(pages.auth.ForgotPassword, {}, { url: this.request.path, title: 'Forgot password | Guren Blog' })
  }

  async store(): Promise<Response> {
    const { email } = await this.validateBody(ForgotPasswordSchema)

    // Resolved before the lookup on purpose: a misconfigured APP_URL throws,
    // and throwing only for addresses that turned out to exist would answer
    // the question the generic status message below refuses to.
    const resetBaseUrl = `${appUrl(this.request)}/reset-password`

    // Always respond with the same status message whether or not the
    // account exists, to avoid leaking which emails are registered. The
    // email itself is dispatched to a queue rather than awaited inline, so
    // the (comparatively slow) mail-transport round-trip can't be used as a
    // timing side-channel to tell known accounts apart from unknown ones.
    const [user] = await User.where({ email })
    if (user) {
      const { token } = await createPasswordResetToken(email, passwordResetStore)
      const resetUrl = buildPasswordResetUrl(resetBaseUrl, token, email)
      await SendPasswordResetEmailJob.dispatch({ email, resetUrl })
    }

    return this.inertia(pages.auth.ForgotPassword, { status: STATUS_MESSAGE }, {
      url: this.request.path,
      title: 'Forgot password | Guren Blog',
    })
  }
}

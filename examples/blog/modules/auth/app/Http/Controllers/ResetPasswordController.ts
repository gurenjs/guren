import { Controller, ValidationException, completePasswordReset } from '@guren/core'
import { ResetPasswordSchema } from '../Validators/ResetPasswordValidator.js'
import { User } from '../../../../../app/Models/User.js'
import { passwordResetStore } from '../../../../../app/Auth/PasswordResetStore.js'
import { pages } from '@/.guren/pages.gen'

const INVALID_TOKEN_MESSAGE = 'This password reset link is invalid or has expired.'

export default class ResetPasswordController extends Controller {
  async show(): Promise<Response> {
    const token = this.request.query('token') ?? ''
    const email = this.request.query('email') ?? ''
    return this.inertia(pages.auth.ResetPassword, { token, email }, { title: 'Reset password | Guren Blog' })
  }

  async store(): Promise<Response> {
    const { token, password } = await this.validateBody(ResetPasswordSchema)

    const user = await completePasswordReset(token, password, passwordResetStore, {
      async retrieveByCredentials({ email }) {
        const [record] = await User.where({ email: String(email) })
        return record ?? null
      },
    }, async (record, newPassword) => {
      // AuthenticatableModel hashes the virtual password before persisting it.
      await User.update({ id: record.id }, { password: newPassword })
    })
    if (!user) {
      throw ValidationException.withMessages({ token: INVALID_TOKEN_MESSAGE })
    }

    return this.redirect('/login')
  }
}

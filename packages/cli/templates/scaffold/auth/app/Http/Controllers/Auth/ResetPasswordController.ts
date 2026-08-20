import { Controller, ValidationException, verifyPasswordResetToken } from '@guren/core'
import { ResetPasswordSchema } from '../../Validators/ResetPasswordValidator.js'
import { User } from '../../../Models/User.js'
import { passwordResetStore } from '../../../Auth/PasswordResetStore.js'
import { pages } from '@/.guren/pages.gen'

const INVALID_TOKEN_MESSAGE = 'This password reset link is invalid or has expired.'

export default class ResetPasswordController extends Controller {
  async show(): Promise<Response> {
    const token = this.request.query('token') ?? ''
    const email = this.request.query('email') ?? ''
    return this.inertia(pages.auth.ResetPassword, { token, email }, { title: 'Reset password' })
  }

  async store(): Promise<Response> {
    const { token, password } = await this.validateBody(ResetPasswordSchema)

    const email = await verifyPasswordResetToken(token, passwordResetStore)
    if (!email) {
      throw ValidationException.withMessages({ token: INVALID_TOKEN_MESSAGE })
    }

    const [user] = await User.where({ email })
    if (!user) {
      throw ValidationException.withMessages({ token: INVALID_TOKEN_MESSAGE })
    }

    // AuthenticatableModel hashes the virtual `password` field into
    // `passwordHash` before persisting — see app/Models/User.ts.
    await User.update({ id: user.id }, { password })
    await passwordResetStore.deleteForEmail(email)

    return this.redirect('/login')
  }
}

import { Controller, ValidationException, createEmailVerificationToken, buildVerificationUrl } from '@guren/core'
import { RegisterSchema } from '../../Validators/RegisterValidator.js'
import { User } from '../../../Models/User.js'
import { emailVerificationStore } from '../../../Auth/EmailVerificationStore.js'
import { appUrl } from '../../../Auth/AppUrl.js'
import { sendEmailVerificationMail } from '../../../Mail/EmailVerificationMail.js'
import { SendWelcomeEmailJob } from '../../../Jobs/SendWelcomeEmailJob.js'
import { pages } from '@/.guren/pages.gen'

export default class RegisterController extends Controller {
  async show(): Promise<Response> {
    return this.inertia(pages.auth.Register, {}, { title: 'Register | Guren Blog' })
  }

  async store(): Promise<Response> {
    const { name, email, password } = await this.validateBody(RegisterSchema)

    const existing = await User.where({ email })
    if (existing.length > 0) {
      throw ValidationException.withMessages({ email: 'An account with this email already exists.' })
    }

    // AuthenticatableModel hashes the virtual `password` field into
    // `passwordHash` before persisting — see app/Models/User.ts.
    const user = await User.create({ name, email, password })

    await SendWelcomeEmailJob.dispatch({ userId: user.id })

    const { token } = await createEmailVerificationToken(user.email, emailVerificationStore)
    const verifyUrl = buildVerificationUrl(`${appUrl(this.request)}/verify-email/confirm`, token, user.email)
    await sendEmailVerificationMail(this.make('mail'), user.email, verifyUrl)

    this.auth.session()?.regenerate()
    await this.auth.login(user)

    return this.redirect('/verify-email')
  }
}

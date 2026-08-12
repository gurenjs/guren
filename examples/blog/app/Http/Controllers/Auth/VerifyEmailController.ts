import { Controller, createEmailVerificationToken, completeEmailVerification, buildVerificationUrl } from '@guren/core'
import { User, type UserRecord } from '../../../Models/User.js'
import { emailVerificationStore } from '../../../Auth/EmailVerificationStore.js'
import { appUrl } from '../../../Auth/AppUrl.js'
import { sendEmailVerificationMail } from '../../../Mail/EmailVerificationMail.js'
import { pages } from '@/.guren/pages.gen'

const EXPIRED_MESSAGE = 'This verification link is invalid or has expired. Request a new one below.'

export default class VerifyEmailController extends Controller {
  async notice(): Promise<Response> {
    const user = await this.auth.userOrFail<UserRecord>()
    if (user.emailVerifiedAt) {
      return this.redirect('/dashboard')
    }

    return this.inertia(pages.auth.VerifyEmail, {}, { title: 'Verify email | Guren Blog' })
  }

  async resend(): Promise<Response> {
    const user = await this.auth.userOrFail<UserRecord>()

    if (!user.emailVerifiedAt) {
      const { token } = await createEmailVerificationToken(user.email, emailVerificationStore)
      const verifyUrl = buildVerificationUrl(`${appUrl(this.request)}/verify-email/confirm`, token, user.email)
      await sendEmailVerificationMail(this.make('mail'), user.email, verifyUrl)
    }

    return this.inertia(pages.auth.VerifyEmail, {
      status: 'A new verification link has been sent to your email address.',
    }, { title: 'Verify email | Guren Blog' })
  }

  async confirm(): Promise<Response> {
    const token = this.request.query('token') ?? ''

    const verifiedEmail = await completeEmailVerification(token, emailVerificationStore, async (email) => {
      await User.update({ email }, { emailVerifiedAt: new Date() })
      return email
    })

    if (!verifiedEmail) {
      return this.inertia(pages.auth.VerifyEmail, { status: EXPIRED_MESSAGE }, { title: 'Verify email | Guren Blog' })
    }

    return this.redirect('/dashboard')
  }
}

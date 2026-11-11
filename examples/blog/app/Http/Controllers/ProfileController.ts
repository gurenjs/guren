import { Controller, ValidationException, createEmailVerificationToken, buildVerificationUrl } from '@guren/core'
import { ProfileUpdateSchema } from '../Validators/ProfileValidator.js'
import { User, type UserRecord } from '../../Models/User.js'
import { emailVerificationStore } from '../../Auth/EmailVerificationStore.js'
import { appUrl } from '../../Auth/AppUrl.js'
import { sendEmailVerificationMail } from '../../Mail/EmailVerificationMail.js'
import { pages } from '@/.guren/pages.gen'

export default class ProfileController extends Controller {
  async edit(): Promise<Response> {
    const authed = await this.auth.user<UserRecord | null>()
    if (!authed) {
      return this.redirect('/login')
    }

    return this.inertia(pages.profile.Edit, {
      profile: { name: authed.name, email: authed.email },
    }, { title: 'Edit Profile | Guren Blog' })
  }

  async update(): Promise<Response> {
    const authed = await this.auth.user<UserRecord | null>()
    if (!authed) {
      return this.redirect('/login')
    }

    // A ValidationException here is caught by InertiaServiceProvider, flashed to
    // the session and redirected back (303); useForm() keeps the typed input.
    const { name, email, password: rawPassword, currentPassword } = await this.validateBody(ProfileUpdateSchema)
    const password = rawPassword ?? ''

    // Normalized as the schema normalizes `email`: a stored address differing only in case or
    // whitespace is the same mailbox, so neither a credential change nor a new address to verify.
    const emailChanged = email !== authed.email.trim().toLowerCase()
    if (emailChanged || password !== '') {
      await this.confirmCurrentPassword(authed.email, currentPassword)
    }

    if (emailChanged) {
      const existing = await User.where({ email })
      const conflict = existing.find((user) => user.id !== authed.id)
      if (conflict) {
        throw ValidationException.withMessages({ email: 'Email is already in use.' })
      }
    }

    const data = { name, email, ...(password ? { password } : {}) }
    if (emailChanged) {
      // The new address is unproven: it must not inherit the old one's verified status.
      await User.update({ id: authed.id }, data, { set: { emailVerifiedAt: null } })
    } else {
      await User.update({ id: authed.id }, data)
    }

    const refreshedUser = await User.find(authed.id)
    if (!refreshedUser) {
      throw new Error('Failed to reload user after profile update.')
    }

    await this.auth.login(refreshedUser)

    if (emailChanged) {
      const { token } = await createEmailVerificationToken(email, emailVerificationStore)
      const verifyUrl = buildVerificationUrl(`${appUrl(this.request)}/verify-email/confirm`, token, email)
      await sendEmailVerificationMail(this.make('mail'), email, verifyUrl)
    }

    return this.inertia(pages.profile.Edit, {
      profile: { name, email },
      status: emailChanged
        ? 'Profile updated. Check your new email address for a verification link.'
        : 'Profile updated successfully.',
    }, { title: 'Edit Profile | Guren Blog' })
  }

  // A session alone must not rotate the credentials that recover the account: the login()
  // above would sign a stolen session in under the new password and sign the owner out.
  // An account with no password hash (created through OAuth) fails here too. The guard is named:
  // unqualified, a Bearer request resolves the token guard, whose validate() always throws.
  private async confirmCurrentPassword(email: string, currentPassword: string): Promise<void> {
    if (currentPassword === '') {
      throw ValidationException.withMessages({ currentPassword: 'Enter your current password to make this change.' })
    }
    const confirmed = await this.auth.guard('web').validate({ email, password: currentPassword })
    if (!confirmed) {
      throw ValidationException.withMessages({ currentPassword: 'The current password is incorrect.' })
    }
  }
}

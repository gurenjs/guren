import { Controller, ValidationException } from '@guren/core'
import { User, type UserRecord } from '../../Models/User.js'
import { pages } from '@/.guren/pages.gen'

export default class ProfileController extends Controller {
  async edit(): Promise<Response> {
    const user = await this.auth.user<UserRecord | null>()
    if (!user) {
      return this.redirect('/login')
    }

    return this.inertia(pages.profile.Edit, {
      profile: {
        name: user.name,
        email: user.email,
      },
    }, { title: 'Profile' })
  }

  async update(): Promise<Response> {
    const user = await this.auth.user<UserRecord | null>()
    if (!user) {
      return this.redirect('/login')
    }

    const { name, email, password, currentPassword } = this.validated('profile.update').body
    const emailChanged = email !== user.email

    // Normalized as the schema normalizes `email`: a stored address differing
    // only in case or whitespace is the same mailbox, so not a credential change.
    const credentialsChanged = email !== user.email.trim().toLowerCase() || password !== ''
    if (credentialsChanged) {
      await this.currentPasswordCheck(user.email, currentPassword)
    }

    if (emailChanged) {
      const existing = await User.where({ email })
      const conflict = existing.find((candidate) => candidate.id !== user.id)
      if (conflict) {
        throw ValidationException.withMessages({ email: 'Email is already in use.' })
      }
    }

    await User.update({ id: user.id }, {
      name,
      email,
      ...(password ? { password } : {}),
    })

    const refreshed = await User.find(user.id)
    if (refreshed) {
      await this.auth.login(refreshed)
    }

    return this.inertia(pages.profile.Edit, {
      profile: { name, email },
      status: 'Profile updated successfully.',
    }, { title: 'Profile' })
  }

  // A session alone must not rotate the credentials that recover the account.
  // An account with no password hash (created through OAuth) fails here too.
  private async currentPasswordCheck(email: string, currentPassword: string): Promise<void> {
    if (currentPassword === '') {
      throw ValidationException.withMessages({ currentPassword: 'Enter your current password to make this change.' })
    }
    const confirmed = await this.auth.guard().validate({ email, password: currentPassword })
    if (!confirmed) {
      throw ValidationException.withMessages({ currentPassword: 'The current password is incorrect.' })
    }
  }
}

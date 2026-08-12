import { Controller, ValidationException } from '@guren/core'
import { User, type UserRecord } from '../../Models/User.js'
import { ProfileUpdateSchema } from '../Validators/ProfileValidator.js'
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

    const { name, email, password } = await this.validateBody(ProfileUpdateSchema)
    const emailChanged = email !== user.email

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
}

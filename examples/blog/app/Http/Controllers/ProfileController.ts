import { Controller, ValidationException } from '@guren/core'
import { ProfileUpdateSchema } from '../Validators/ProfileValidator.js'
import { User, type UserRecord } from '../../Models/User.js'
import { pages } from '@/.guren/pages.gen'

export default class ProfileController extends Controller {
  async edit(): Promise<Response> {
    const authed = await this.auth.user<UserRecord | null>()
    if (!authed) {
      return this.redirect('/login')
    }

    return this.inertia(pages.profile.Edit, {
      profile: { name: authed.name, email: authed.email },
    }, { url: this.request.path, title: 'Edit Profile | Guren Blog' })
  }

  async update(): Promise<Response> {
    const authed = await this.auth.user<UserRecord | null>()
    if (!authed) {
      return this.redirect('/login')
    }

    // validateBody throws ValidationException on failure →
    // InertiaServiceProvider catches it, flashes errors to session, and redirects back (303).
    // Inertia's useForm() preserves client-side input state across the redirect.
    const { name, email, password: rawPassword } = await this.validateBody(ProfileUpdateSchema)
    const password = rawPassword ?? ''

    if (email !== authed.email) {
      const existing = await User.where({ email })
      const conflict = existing.find((user) => user.id !== authed.id)
      if (conflict) {
        throw ValidationException.withMessages({ email: 'Email is already in use.' })
      }
    }

    const updates: Record<string, unknown> = {
      name,
      email,
    }

    if (password) {
      updates.password = password
    }

    await User.update({ id: authed.id }, updates)

    const refreshedUser = await User.find(authed.id)
    if (!refreshedUser) {
      throw new Error('Failed to reload user after profile update.')
    }

    await this.auth.login(refreshedUser)

    return this.inertia(pages.profile.Edit, {
      profile: { name, email },
      status: 'Profile updated successfully.',
    }, { url: this.request.path, title: 'Edit Profile | Guren Blog' })
  }
}

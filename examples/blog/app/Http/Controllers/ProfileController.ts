import { Controller, parseRequestPayload, formatValidationErrors } from '@guren/server'
import { ProfileUpdateSchema } from '../Validators/ProfileValidator.js'
import { User, type UserRecord } from '../../Models/User.js'

type ProfileProps = {
  name: string
  email: string
}

type ProfilePageProps = {
  profile: ProfileProps
  errors?: Record<string, string>
  status?: string
}

export default class ProfileController extends Controller {
  async edit(): Promise<Response> {
    const authed = await this.auth.user<UserRecord | null>()
    if (!authed) {
      return this.redirect('/login')
    }

    return this.inertia<
      'profile/Edit',
      ProfilePageProps
    >('profile/Edit', { profile: { name: authed.name, email: authed.email } }, { url: this.request.path, title: 'Edit Profile | Guren Blog' })
  }

  async update(): Promise<Response> {
    const authed = await this.auth.user<UserRecord | null>()
    if (!authed) {
      return this.redirect('/login')
    }

    const rawPayload = await parseRequestPayload(this.ctx)
    const parsed = ProfileUpdateSchema.safeParse(rawPayload)

    if (!parsed.success) {
      const errors = formatValidationErrors(parsed.error)
      return this.inertia('profile/Edit', {
        profile: { name: authed.name, email: authed.email },
        errors,
      }, { status: 422 })
    }

    const { name, email, password } = parsed.data
    const errors: Record<string, string> = {}

    if (email !== authed.email) {
      const existing = await User.where({ email })
      const conflict = existing.find((user) => user.id !== authed.id)
      if (conflict) {
        errors.email = 'Email is already in use.'
      }
    }

    if (Object.keys(errors).length > 0) {
      return this.inertia('profile/Edit', {
        profile: { name, email },
        errors,
      }, { status: 422 })
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

    return this.inertia('profile/Edit', {
      profile: { name, email },
      status: 'Profile updated successfully.',
    }, { url: this.request.path, title: 'Edit Profile | Guren Blog' })
  }
}

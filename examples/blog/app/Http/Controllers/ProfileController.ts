import { Context, parseRequestPayload, formatValidationErrors } from '@guren/server'
import { ScryptHasher } from '@guren/core'
import Controller from './Controller.js'
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
  async edit(ctx: Context): Promise<Response> {
    const authed = await this.auth.user<UserRecord | null>()
    if (!authed) {
      return this.redirect('/login')
    }

    return this.inertiaWithAuth<
      'profile/Edit',
      ProfilePageProps
    >('profile/Edit', { profile: { name: authed.name, email: authed.email } }, { url: ctx.req.path, title: 'Edit Profile | Guren Blog' })
  }

  async update(ctx: Context): Promise<Response> {
    const authed = await this.auth.user<UserRecord | null>()
    if (!authed) {
      return this.redirect('/login')
    }

    const rawPayload = await parseRequestPayload(ctx)
    const parsed = ProfileUpdateSchema.safeParse(rawPayload)

    if (!parsed.success) {
      const errors = formatValidationErrors(parsed.error)
      return this.inertiaWithAuth('profile/Edit', {
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
      return this.inertiaWithAuth('profile/Edit', {
        profile: { name, email },
        errors,
      }, { status: 422 })
    }

    const updates = {
      name,
      email,
      passwordHash: undefined as string | undefined,
    }

    if (password) {
      const hasher = new ScryptHasher()
      updates.passwordHash = await hasher.hash(password)
    }

    await User.update({ id: authed.id }, updates)

    const refreshedUser: UserRecord = {
      ...authed,
      name,
      email,
    }

    if (updates.passwordHash !== undefined) {
      refreshedUser.passwordHash = updates.passwordHash
    }

    await this.auth.login(refreshedUser)

    return this.inertiaWithAuth('profile/Edit', {
      profile: { name, email },
      status: 'Profile updated successfully.',
    }, { url: ctx.req.path, title: 'Edit Profile | Guren Blog' })
  }
}

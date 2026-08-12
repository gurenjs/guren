import { Controller, ValidationException } from '@guren/core'
import { RegisterSchema } from '../../Validators/RegisterValidator.js'
import { User } from '../../../Models/User.js'
import { pages } from '@/.guren/pages.gen'

export default class RegisterController extends Controller {
  async show(): Promise<Response> {
    return this.inertia(pages.auth.Register, {}, { title: 'Register' })
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

    this.auth.session()?.regenerate()
    await this.auth.login(user)

    return this.redirect('/dashboard')
  }
}

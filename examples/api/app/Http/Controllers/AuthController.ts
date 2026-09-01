import { Controller, createApiToken, Hash, ValidationException } from '@guren/core'
import { User } from '../../Models/User.js'
import { UserResource } from '../Resources/UserResource.js'
import { RegisterSchema, LoginSchema } from '../Validators/AuthValidator.js'
import { UserRegistered } from '../../Events/UserRegistered.js'
import { getTokenStore } from '../../Providers/ApiTokenProvider.js'

export default class AuthController extends Controller {
  // POST /api/auth/register
  async register(): Promise<Response> {
    const { name, email, password } = await this.validateBody(RegisterSchema)

    const existing = await User.first({ email })
    if (existing) {
      throw ValidationException.withMessages({ email: 'Email already registered' })
    }

    const user = await User.create({ name, email, password })

    const { plainTextToken, token } = await createApiToken(getTokenStore(), {
      name: 'Initial Token',
      userId: user!.id,
      abilities: ['*'],
    })

    await this.make('events').emit(new UserRegistered(user!.id, user!.email, user!.name))

    return this.created({
      user: new UserResource(user!).toJSON(),
      token: plainTextToken,
      tokenId: token.id,
    })
  }

  // POST /api/auth/login
  async login(): Promise<Response> {
    const { email, password } = await this.validateBody(LoginSchema)
    const user = await User.first({ email })

    if (!user || !(await new Hash().verify(user.passwordHash, password))) {
      return this.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    const { plainTextToken, token } = await createApiToken(getTokenStore(), {
      name: 'Login Token',
      userId: user.id,
      abilities: ['*'],
    })

    return this.json({
      user: new UserResource(user).toJSON(),
      token: plainTextToken,
      tokenId: token.id,
    })
  }

  // GET /api/auth/user (authenticated)
  async user(): Promise<Response> {
    const { userId, abilities } = this.apiToken()
    const user = await User.findOrFail(userId)

    return this.json({
      user: new UserResource(user).toJSON(),
      tokenAbilities: abilities,
    })
  }
}

import { Controller, createApiToken, Hash, ValidationException } from '@guren/core'
import { User } from '../../Models/User.js'
import { UserResource } from '../Resources/UserResource.js'
import { RegisterSchema, LoginSchema } from '../Validators/AuthValidator.js'
import { UserRegistered } from '../../Events/UserRegistered.js'
import { getTokenStore } from '../../Providers/ApiTokenProvider.js'

const hash = new Hash()
let missingUserHash: Promise<string> | undefined

// An unknown address verifies against a hash no password opens, so it costs about what a wrong password costs.
function hashForMissingUser(): Promise<string> {
  missingUserHash ??= hash.hash(crypto.randomUUID()).catch((error: unknown) => {
    missingUserHash = undefined
    throw error
  })
  return missingUserHash
}

export default class AuthController extends Controller {
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

  async login(): Promise<Response> {
    const { email, password } = await this.validateBody(LoginSchema)
    const user = await User.first({ email })

    const valid = await hash.verify(user?.passwordHash ?? await hashForMissingUser(), password)

    if (!user || !valid) {
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

  async user(): Promise<Response> {
    const { userId, abilities } = this.apiToken()
    const user = await User.findOrFail(userId)

    return this.json({
      user: new UserResource(user).toJSON(),
      tokenAbilities: abilities,
    })
  }
}

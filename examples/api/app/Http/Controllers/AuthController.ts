import {
  Controller,
  parseRequestPayload,
  formatValidationErrors,
  createApiToken,
  revokeApiToken,
  getUserApiTokens,
  getApiToken,
  MemoryApiTokenStore,
} from '@guren/server'
import { ScryptHasher } from '@guren/core'
import { User } from '../../Models/User.js'
import { UserResource } from '../Resources/UserResource.js'
import { RegisterSchema, LoginSchema, CreateTokenSchema } from '../Validators/AuthValidator.js'
import { getEventManager } from '../../Providers/EventServiceProvider.js'
import { UserRegistered } from '../../Events/UserRegistered.js'

// Shared token store (in production, use DB-backed store)
export const tokenStore = new MemoryApiTokenStore()

export default class AuthController extends Controller {
  private hasher = new ScryptHasher()

  // POST /api/auth/register
  async register(): Promise<Response> {
    const payload = await parseRequestPayload(this.ctx)
    const result = RegisterSchema.safeParse(payload)

    if (!result.success) {
      return this.json({ errors: formatValidationErrors(result.error) }, { status: 422 })
    }

    const { name, email, password } = result.data

    // Check if email already exists
    const existing = await User.first({ email })
    if (existing) {
      return this.json({ errors: { email: 'Email already registered' } }, { status: 422 })
    }

    const passwordHash = await this.hasher.hash(password)
    const user = await User.create({ name, email, passwordHash })

    if (!user) {
      return this.json({ error: 'Failed to create user' }, { status: 500 })
    }

    // Create initial token
    const { plainTextToken, token } = await createApiToken(tokenStore, {
      name: 'Initial Token',
      userId: user.id,
      abilities: ['*'],
    })

    // Emit UserRegistered event
    const events = getEventManager()
    await events.emit(new UserRegistered(user.id, user.email, user.name))

    return this.json({
      user: new UserResource(user).toJSON(),
      token: plainTextToken,
      tokenId: token.id,
    }, { status: 201 })
  }

  // POST /api/auth/login
  async login(): Promise<Response> {
    const payload = await parseRequestPayload(this.ctx)
    const result = LoginSchema.safeParse(payload)

    if (!result.success) {
      return this.json({ errors: formatValidationErrors(result.error) }, { status: 422 })
    }

    const { email, password } = result.data
    const user = await User.first({ email })

    if (!user) {
      return this.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    const valid = await this.hasher.verify(password, user.passwordHash)
    if (!valid) {
      return this.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    const { plainTextToken, token } = await createApiToken(tokenStore, {
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
    const tokenInfo = getApiToken(this.ctx)
    if (!tokenInfo) {
      return this.json({ error: 'Unauthenticated' }, { status: 401 })
    }

    const user = await User.find(tokenInfo.userId)
    if (!user) {
      return this.json({ error: 'User not found' }, { status: 404 })
    }

    return this.json({
      user: new UserResource(user).toJSON(),
      tokenAbilities: tokenInfo.abilities,
    })
  }

  // POST /api/auth/tokens (authenticated) - create additional token
  async createToken(): Promise<Response> {
    const tokenInfo = getApiToken(this.ctx)
    if (!tokenInfo) {
      return this.json({ error: 'Unauthenticated' }, { status: 401 })
    }

    const payload = await parseRequestPayload(this.ctx)
    const result = CreateTokenSchema.safeParse(payload)

    if (!result.success) {
      return this.json({ errors: formatValidationErrors(result.error) }, { status: 422 })
    }

    const { name, abilities, expiresInDays } = result.data
    const expiresIn = expiresInDays ? expiresInDays * 24 * 60 * 60 * 1000 : null

    const { plainTextToken, token } = await createApiToken(tokenStore, {
      name,
      userId: tokenInfo.userId,
      abilities,
      expiresIn,
    })

    return this.json({
      token: plainTextToken,
      tokenId: token.id,
      name: token.name,
      abilities: token.abilities,
      expiresAt: token.expiresAt?.toISOString() ?? null,
    }, { status: 201 })
  }

  // GET /api/auth/tokens (authenticated) - list user's tokens
  async listTokens(): Promise<Response> {
    const tokenInfo = getApiToken(this.ctx)
    if (!tokenInfo) {
      return this.json({ error: 'Unauthenticated' }, { status: 401 })
    }

    const tokens = await getUserApiTokens(tokenInfo.userId, tokenStore)

    return this.json({
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        abilities: t.abilities,
        lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        expiresAt: t.expiresAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
      })),
    })
  }

  // DELETE /api/auth/tokens/:id (authenticated)
  async revokeToken(): Promise<Response> {
    const tokenInfo = getApiToken(this.ctx)
    if (!tokenInfo) {
      return this.json({ error: 'Unauthenticated' }, { status: 401 })
    }

    const tokenId = this.request.param('id')
    if (!tokenId) {
      return this.json({ error: 'Token ID required' }, { status: 400 })
    }

    // Verify token belongs to user
    const userTokens = await getUserApiTokens(tokenInfo.userId, tokenStore)
    const targetToken = userTokens.find((t) => t.id === tokenId)

    if (!targetToken) {
      return this.json({ error: 'Token not found' }, { status: 404 })
    }

    await revokeApiToken(tokenId, tokenStore)

    return this.json({ message: 'Token revoked' })
  }
}

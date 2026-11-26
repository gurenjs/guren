import { Controller, createApiToken, getUserApiTokens, revokeApiToken } from '@guren/core'
import { CreateTokenSchema, TokenIdParamSchema } from '../Validators/AuthValidator.js'
import { getTokenStore } from '../../Providers/ApiTokenProvider.js'

export default class TokenController extends Controller {
  async index(): Promise<Response> {
    const { userId } = this.apiToken()
    const tokens = await getUserApiTokens(userId, getTokenStore())

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

  async store(): Promise<Response> {
    const { userId, abilities: callerAbilities, token: caller } = this.apiToken()
    // Reserved for `*` tokens: a token minted by a scoped one would outlive the scoped one's revocation.
    if (!callerAbilities.includes('*')) {
      return this.json({ error: 'Token lacks required abilities', required: ['*'] }, { status: 403 })
    }

    const { name, abilities, expiresInDays } = await this.validateBody(CreateTokenSchema)
    const requested = expiresInDays ? expiresInDays * 24 * 60 * 60 * 1000 : null
    const remaining = caller.expiresAt ? caller.expiresAt.getTime() - Date.now() : null
    const expiresIn = remaining === null ? requested : Math.min(requested ?? remaining, remaining)

    const { plainTextToken, token } = await createApiToken(getTokenStore(), {
      name,
      userId,
      abilities,
      expiresIn,
    })

    return this.created({
      token: plainTextToken,
      tokenId: token.id,
      name: token.name,
      abilities: token.abilities,
      expiresAt: token.expiresAt?.toISOString() ?? null,
    })
  }

  async destroy(): Promise<Response> {
    const { userId } = this.apiToken()
    const { id: tokenId } = this.validateParams(TokenIdParamSchema)

    const userTokens = await getUserApiTokens(userId, getTokenStore())
    const targetToken = userTokens.find((t) => t.id === tokenId)

    if (!targetToken) {
      return this.json({ error: 'Token not found' }, { status: 404 })
    }

    await revokeApiToken(tokenId, getTokenStore())

    return this.json({ message: 'Token revoked' })
  }
}

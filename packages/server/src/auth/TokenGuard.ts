import type { Context } from 'hono'
import type { AuthCredentials, Guard, UserProvider } from './types'
import type { Session } from '../http/middleware'
import {
  API_TOKEN_KEY,
  parseApiToken,
  readBearerToken,
  revokeApiToken,
  verifyApiToken,
  type ApiTokenStore,
  type VerifiedApiToken,
} from './api-token'
import { sanitizeUser } from './providers/UserProvider'

export interface TokenGuardOptions<User = unknown> {
  store: ApiTokenStore
  ctx: Context
  /**
   * Resolves the token's userId to a full user record. Without one the guard
   * still authenticates: `user()` resolves to a minimal `{ id }` record.
   */
  provider?: UserProvider<User>
  /** Update the token's lastUsedAt on successful verification. Default true. */
  updateLastUsed?: boolean
}

/**
 * Bearer-token Guard (RFC 0016 Phase 0). Credential flows (`attempt`,
 * `login`, `validate`) throw; `logout()` revokes the presented token and
 * leaves a co-present session alone. Answers authentication only — token
 * abilities are enforced elsewhere (`tokenCan*`, the RFC 0016 scope gate).
 */
export class TokenGuard<User = unknown> implements Guard<User> {
  private readonly ctx: Context
  private readonly store: ApiTokenStore
  private readonly provider?: UserProvider<User>
  private readonly updateLastUsed: boolean

  private verification?: Promise<VerifiedApiToken | null>
  private resolvedUser?: Promise<User | null>

  constructor(options: TokenGuardOptions<User>) {
    this.ctx = options.ctx
    this.store = options.store
    this.provider = options.provider
    this.updateLastUsed = options.updateLastUsed ?? true
  }

  private verify(): Promise<VerifiedApiToken | null> {
    if (!this.verification) {
      this.verification = (async () => {
        const plainTextToken = readBearerToken(this.ctx.req.header('Authorization'))
        if (!plainTextToken) return null

        // Reuse createBearerTokenMiddleware's result rather than repeating the
        // hash, the store read, and the lastUsedAt write.
        const existing = this.ctx.get(API_TOKEN_KEY) as VerifiedApiToken | undefined
        if (existing && existing.token.id === parseApiToken(plainTextToken)?.id) {
          return existing
        }

        const result = await verifyApiToken(plainTextToken, this.store, {
          updateLastUsed: this.updateLastUsed,
        })
        if (result) {
          this.ctx.set(API_TOKEN_KEY, result)
        }
        return result
      })()
    }
    return this.verification
  }

  // A valid token whose user no longer resolves (deleted account, unrevoked
  // token) is NOT authenticated, so this goes through user(), not verify().
  async check(): Promise<boolean> {
    return (await this.user()) !== null
  }

  async guest(): Promise<boolean> {
    return !(await this.check())
  }

  user<T = User>(): Promise<T | null> {
    if (!this.resolvedUser) {
      this.resolvedUser = (async () => {
        const result = await this.verify()
        if (!result) return null

        if (!this.provider) {
          return { id: result.userId } as unknown as User
        }

        const record = await this.provider.retrieveById(result.userId)
        return record ? sanitizeUser(this.provider, record) : null
      })()
    }
    return this.resolvedUser as Promise<T | null>
  }

  async id(): Promise<unknown> {
    const result = await this.verify()
    return result?.userId ?? null
  }

  async login(): Promise<void> {
    throw new Error('TokenGuard does not support login(); issue a token with createApiToken() instead.')
  }

  async attempt(_credentials: AuthCredentials, _remember?: boolean): Promise<boolean> {
    throw new Error('TokenGuard does not support attempt(); bearer tokens are not credential-based.')
  }

  async validate(_credentials: AuthCredentials): Promise<User | null> {
    throw new Error('TokenGuard does not support validate(); bearer tokens are not credential-based.')
  }

  /** Revokes the presented token. Subsequent requests with it fail verification. */
  async logout(): Promise<void> {
    const result = await this.verify()
    if (result) {
      await revokeApiToken(result.token.id, this.store)
    }
    this.verification = Promise.resolve(null)
    this.resolvedUser = Promise.resolve(null)
    // So getApiToken()/getApiTokenOrFail() cannot succeed after logout on the
    // same request.
    this.ctx.set(API_TOKEN_KEY, undefined)
  }

  session<T extends Session = Session>(): T | undefined {
    return undefined
  }
}

import type { AuthCredentials, Authenticatable, UserProvider } from '../types'

/**
 * Run a user record through the provider's optional `sanitize` before it
 * leaves the auth layer. Every guard must call this on anything it returns
 * from `user()` — a guard that forgets the optional-chaining ternary leaks
 * password hashes, so the ternary lives here, once.
 */
export function sanitizeUser<User>(provider: UserProvider<User>, user: User): User {
  return provider.sanitize ? provider.sanitize(user) : user
}

export abstract class BaseUserProvider<User extends Authenticatable = Authenticatable> implements UserProvider<User> {
  abstract retrieveById(identifier: unknown): Promise<User | null>
  abstract retrieveByCredentials(credentials: AuthCredentials): Promise<User | null>
  abstract validateCredentials(user: User, credentials: AuthCredentials): Promise<boolean>
  abstract getId(user: User): unknown

  async setRememberToken(user: User, token: string | null): Promise<void> {
    if (typeof user.setRememberToken === 'function') {
      await user.setRememberToken(token)
    }
  }

  async getRememberToken(user: User): Promise<string | null> {
    if (typeof user.getRememberToken === 'function') {
      return (await user.getRememberToken()) ?? null
    }

    return null
  }
}

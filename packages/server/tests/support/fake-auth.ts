import type { Guard, UserProvider } from '../../src/auth/types'

/** A guard that answers unauthenticated, for a case that overrides what it asks. */
export function fakeGuard<User = unknown>(overrides: Partial<Guard<User>> = {}): Guard<User> {
  return {
    async check() { return false },
    async guest() { return true },
    async user() { return null },
    async id() { return null },
    async login() {},
    async logout() {},
    async attempt() { return false },
    async validate() { return null },
    session() { return undefined },
    ...overrides,
  } as Guard<User>
}

/** A user provider that resolves nothing, for a case that overrides what it asks. */
export function fakeUserProvider<User = unknown>(
  overrides: Partial<UserProvider<User>> = {},
): UserProvider<User> {
  return {
    async retrieveById() { return null },
    async retrieveByCredentials() { return null },
    async validateCredentials() { return false },
    getId() { return null },
    ...overrides,
  } as UserProvider<User>
}

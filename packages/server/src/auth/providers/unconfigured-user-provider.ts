import type { UserProvider } from '../types'

export const NO_USER_PROVIDER_MESSAGE =
  'AuthManager: a login was attempted, but no user provider is registered, so there is ' +
  'nothing to check the credentials against. Register one with `auth.useModel(User)` in a ' +
  "service provider (what `guren add auth` scaffolds), or `auth.registerProvider('users', ...)`."

function noProvider(): never {
  throw new Error(NO_USER_PROVIDER_MESSAGE)
}

/**
 * The provider behind the default guard until an app registers `users`. An
 * anonymous request on an app with no auth is legitimately unauthenticated, so
 * `retrieveById` answers null; a credential check with nothing to check
 * against is a misconfiguration, so it throws rather than answering "wrong
 * password" forever.
 */
export function createUnconfiguredUserProvider(): UserProvider {
  return {
    retrieveById: async () => null,
    retrieveByCredentials: async () => noProvider(),
    validateCredentials: async () => noProvider(),
    getId: () => noProvider(),
  }
}

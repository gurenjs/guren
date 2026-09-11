import type { Authenticatable, UserProvider } from '../types'

export const NO_USER_PROVIDER_MESSAGE =
  'AuthManager: a login was attempted, but no user provider is registered, so there is ' +
  'nothing to check the credentials against. Register one with `auth.useModel(User)` in a ' +
  "service provider (what `guren add auth` scaffolds), or `auth.registerProvider('users', ...)`. " +
  'An OAuth or passwordless app that only calls `auth.login(user)` needs no provider for that ' +
  'call, but does need one to load the user back on the next request.'

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
    // Read off the record, not thrown: `auth.login(user)` after an OAuth
    // callback hands the guard a user it already has, and only needs an
    // identifier to put in the session.
    getId: (user) => identifierOf(user),
  }
}

function identifierOf(user: Authenticatable): unknown {
  const record = user as { getAuthIdentifier?: () => unknown; id?: unknown }
  return typeof record?.getAuthIdentifier === 'function' ? record.getAuthIdentifier() : record?.id
}

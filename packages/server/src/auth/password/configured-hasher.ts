import { getContainer } from '../../container/Container'
import { DefaultHasher, type PasswordHashAlgorithm } from './DefaultHasher'
import type { PasswordHasher } from './PasswordHasher'

/**
 * What `createApp({ auth: { hasher } })` accepts: an algorithm name for the
 * built-in `DefaultHasher`, or a `PasswordHasher` of the app's own.
 */
export type PasswordHasherOption = PasswordHashAlgorithm | PasswordHasher

export function createPasswordHasher(option: PasswordHasherOption | undefined): PasswordHasher {
  if (option === undefined || option === 'scrypt') return new DefaultHasher()
  if (option === 'argon2') return new DefaultHasher({ algorithm: 'argon2' })
  return option
}

let fallback: PasswordHasher | undefined

/**
 * The hasher the current app's `AuthManager` resolved, read through the
 * process-wide container, else a scrypt `DefaultHasher` (a seeder run bare, a
 * unit test). Per call, not memoized: a model module evaluates before
 * `createApp()` runs. Duck-typed on `hasher()`, so a bare container's `auth`
 * binding, or a second copy of this package's, is a fallback rather than a crash.
 */
export function configuredPasswordHasher(): PasswordHasher {
  let auth: { hasher?: unknown } | undefined
  try {
    auth = getContainer().makeOptional<{ hasher?: unknown }>('auth')
  } catch {
    auth = undefined
  }
  if (typeof auth?.hasher === 'function') {
    return (auth.hasher as () => PasswordHasher).call(auth)
  }
  return (fallback ??= new DefaultHasher())
}

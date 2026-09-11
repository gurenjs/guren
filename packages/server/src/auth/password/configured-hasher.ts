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

interface PasswordHasherSlot {
  explicitPasswordHasher(): PasswordHasher | null
  configuredPasswordHasher: PasswordHasher | null
}

/**
 * Duck-typed for the same reason `ModelUserProvider` duck-types its credential
 * columns: two copies of @guren/server coexist through workspace symlinks, and
 * a nominal check would silently skip the assignment.
 */
function passwordHasherSlot(model: unknown): PasswordHasherSlot | null {
  const candidate = model as Partial<PasswordHasherSlot>
  return typeof candidate?.explicitPasswordHasher === 'function' ? (candidate as PasswordHasherSlot) : null
}

/**
 * Hand the app's hasher to a model class at bind time, rather than letting the
 * class read a process-wide container per hash. A model that declares `static
 * passwordHasher` keeps the author's choice. The slot is a static, so a model
 * class shared by two Applications carries the last binding.
 */
export function bindPasswordHasher(model: unknown, hasher: PasswordHasher): void {
  const slot = passwordHasherSlot(model)
  if (!slot || slot.explicitPasswordHasher()) return
  slot.configuredPasswordHasher = hasher
}

/** The model author's own `static passwordHasher`, which outranks anything an app configures. */
export function declaredPasswordHasher(model: unknown): PasswordHasher | null {
  return passwordHasherSlot(model)?.explicitPasswordHasher() ?? null
}

/** What {@link bindPasswordHasher} left on the class, for a provider built without one. */
export function boundPasswordHasher(model: unknown): PasswordHasher | null {
  return passwordHasherSlot(model)?.configuredPasswordHasher ?? null
}

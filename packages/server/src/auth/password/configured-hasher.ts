import { DefaultHasher, type PasswordHashAlgorithm } from './DefaultHasher'
import { capabilityOf } from '../model-capability'
import type { PasswordHasher } from './PasswordHasher'

/**
 * What `createApp({ auth: { hasher } })` accepts: an algorithm name for the
 * built-in `DefaultHasher`, or a `PasswordHasher` of the app's own.
 */
export type PasswordHasherOption = PasswordHashAlgorithm | PasswordHasher

export function createPasswordHasher(option: PasswordHasherOption | undefined): PasswordHasher {
  if (option === undefined) return defaultPasswordHasher()
  return typeof option === 'string' ? new DefaultHasher({ algorithm: option }) : option
}

let sharedDefaultHasher: PasswordHasher | null = null

/**
 * The scrypt default, constructed once. `DefaultHasher` holds no per-instance
 * state (the testing cost is read per call), and each one allocates three
 * hashers, which an unbound model write would otherwise pay per row.
 */
function defaultPasswordHasher(): PasswordHasher {
  sharedDefaultHasher ??= new DefaultHasher()
  return sharedDefaultHasher
}

interface PasswordHasherSlot {
  explicitPasswordHasher(): PasswordHasher | null
  configuredPasswordHasher: PasswordHasher | null
}

function passwordHasherSlot(model: unknown): PasswordHasherSlot | null {
  return capabilityOf<PasswordHasherSlot>(model, 'explicitPasswordHasher')
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

/**
 * The one hasher precedence, read by the model class and by its provider: the
 * author's `static passwordHasher`, then the caller's override, then what
 * `useModel()` bound, then scrypt. A second spelling of this order is how a
 * model and its provider come to write at different parameters, and every
 * login then asks for a rehash the previous one already made.
 */
export function resolveModelHasher(model: unknown, override?: PasswordHasher): PasswordHasher {
  const slot = passwordHasherSlot(model)
  return slot?.explicitPasswordHasher() ?? override ?? slot?.configuredPasswordHasher ?? defaultPasswordHasher()
}

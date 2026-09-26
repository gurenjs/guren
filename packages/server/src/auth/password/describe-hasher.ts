import { DefaultHasher } from './DefaultHasher'
import { NodeHasher } from './NodeHasher'
import type { PasswordHasher } from './PasswordHasher'
import { ScryptHasher } from './ScryptHasher'

/** What introspection reports of a hasher (RFC 0026 §1): the format it writes, and whether writing needs `Bun.password`. */
export interface PasswordHasherDescription {
  algorithm: 'scrypt' | 'argon2' | 'bcrypt' | null
  requiresBun: boolean | null
}

/**
 * Matched by exact constructor, so a subclass (which may override `hash()`) or an
 * app's own `PasswordHasher` reads as unknown rather than as the class it extends.
 */
export function describePasswordHasher(hasher: PasswordHasher): PasswordHasherDescription {
  switch (hasher.constructor) {
    case DefaultHasher:
      return { algorithm: (hasher as DefaultHasher).algorithm, requiresBun: (hasher as DefaultHasher).algorithm === 'argon2' }
    case NodeHasher:
      return { algorithm: 'scrypt', requiresBun: false }
    case ScryptHasher: {
      // Private in the class; read here, inside the package that owns it.
      const algorithm = (hasher as unknown as { algorithm: string }).algorithm
      return { algorithm: algorithm === 'bcrypt' ? 'bcrypt' : 'argon2', requiresBun: true }
    }
    default:
      return { algorithm: null, requiresBun: null }
  }
}

import type { PasswordHasher } from './PasswordHasher'
import { ScryptHasher } from './ScryptHasher'
import { NodeHasher } from './NodeHasher'
import { NODE_SCRYPT_PREFIX, looksLikePasswordHash } from './hash-format'

/**
 * Runtime-detecting password hasher behind `Hash`, the default for
 * `AuthenticatableModel` and `ModelUserProvider`: `Bun.password` on Bun (Argon2id,
 * despite `ScryptHasher`'s name), `crypto.scrypt` otherwise. **Verification routes
 * on the stored hash, not the runtime**, or a column written elsewhere would 500 on
 * every login; `$scrypt$` verifies anywhere, Argon2id/bcrypt needs `Bun.password`.
 */
export class DefaultHasher implements PasswordHasher {
  private readonly bun: ScryptHasher | null
  private readonly node: NodeHasher

  constructor() {
    this.bun = typeof Bun !== 'undefined' ? new ScryptHasher() : null
    this.node = new NodeHasher()
  }

  hash(plain: string): Promise<string> {
    return (this.bun ?? this.node).hash(plain)
  }

  verify(hashed: string, plain: string): Promise<boolean> {
    return this.delegateFor(hashed).verify(hashed, plain)
  }

  needsRehash(hashed: string): boolean {
    // A hash written by the delegate this runtime does *not* hash with always
    // needs one: this process cannot reproduce that format, whatever the
    // parameters encoded in it say.
    const writtenByNode = hashed.startsWith(NODE_SCRYPT_PREFIX)
    const hashesWithNode = this.bun === null
    if (writtenByNode !== hashesWithNode) {
      return true
    }

    return this.delegateFor(hashed).needsRehash(hashed)
  }

  private delegateFor(hashed: string): ScryptHasher | NodeHasher {
    if (hashed.startsWith(NODE_SCRYPT_PREFIX)) {
      return this.node
    }

    if (!this.bun) {
      if (!looksLikePasswordHash(hashed)) {
        // Saying "written by Bun.password" about an `oauth:...` sentinel would
        // be a confident wrong answer. `ModelUserProvider` never gets here.
        throw new Error(
          'This value is not a password hash in any format the built-in hashers ' +
            'produce, so it cannot be verified. A credential column holding a ' +
            'sentinel for a passwordless account should not reach verify().',
        )
      }

      throw new Error(
        'This password hash was written by Bun.password (Argon2id or bcrypt) and ' +
          'cannot be verified on a runtime without Bun. Hash formats follow the ' +
          'runtime that wrote them, so a column seeded under Bun has to be ' +
          'rehashed before a Node or Workers deploy can read it.',
      )
    }

    return this.bun
  }
}

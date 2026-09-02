import type { PasswordHasher } from './PasswordHasher'
import { ScryptHasher } from './ScryptHasher'
import { NodeHasher } from './NodeHasher'
import { NODE_SCRYPT_PREFIX, looksLikePasswordHash } from './hash-format'

/**
 * Runtime-detecting password hasher: hashes with `Bun.password` when running
 * on Bun (Argon2id by default, despite `ScryptHasher`'s name) and with Node's
 * `crypto.scrypt` otherwise (e.g. AWS Lambda or Cloudflare Workers). This is
 * the hasher behind the `Hash` export, and the default for
 * `AuthenticatableModel` and `ModelUserProvider`.
 *
 * **Verification routes on the stored hash, not on the runtime.** The two
 * delegates write different formats, and neither can read the other's, so
 * picking a delegate by runtime alone would 500 on every login for an app
 * whose password column was written elsewhere - a seeder run on Bun against a
 * database a Node deploy then serves. Bun implements `node:crypto`, so a
 * `$scrypt$` hash verifies on either runtime; an Argon2id or bcrypt hash needs
 * `Bun.password` and cannot be read off Bun at all, which this reports as
 * itself rather than as an opaque parse failure.
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
        // be a confident wrong answer. `ModelUserProvider` never gets here;
        // a direct caller might.
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

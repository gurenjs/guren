import type { PasswordHasher } from './PasswordHasher'
import { ScryptHasher } from './ScryptHasher'
import { NodeHasher } from './NodeHasher'
import { NODE_SCRYPT_PREFIX, looksLikePasswordHash } from './hash-format'

/**
 * Parameters used while `GUREN_TESTING` is set (by `TestApp` and `guren tool:call --as`).
 * The production defaults cost ~136 ms per hash (Bun 1.3, Apple M-series), the whole
 * 180 ms of every test creating a user; these measure ~1 ms. Verification reads the
 * parameters the hash carries, so a hash written here verifies at that cost anywhere.
 */
const TESTING_ARGON2_OPTIONS = { memoryCost: 1024, timeCost: 1 } // KiB, iterations
const TESTING_SCRYPT_COST = 1024 // N

/** Read per call, not at construction: the provider owning this hasher is built at boot, and `TestApp` may set the variable later. */
function testingHashCost(): boolean {
  return typeof process !== 'undefined' && Boolean(process.env.GUREN_TESTING)
}

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
  private readonly testing: ScryptHasher | NodeHasher

  constructor() {
    const onBun = typeof Bun !== 'undefined'
    this.bun = onBun ? new ScryptHasher() : null
    this.node = new NodeHasher()
    this.testing = onBun ? new ScryptHasher(TESTING_ARGON2_OPTIONS) : new NodeHasher({ cost: TESTING_SCRYPT_COST })
  }

  hash(plain: string): Promise<string> {
    return (testingHashCost() ? this.testing : (this.bun ?? this.node)).hash(plain)
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

    // A hash at the testing cost is current only while tests run. Anywhere else it
    // is a downgrade to undo (`guren tool:call --as` writes real rows), which the
    // production delegate cannot see: it carries no costs to compare against.
    if (!this.testing.needsRehash(hashed)) {
      return !testingHashCost()
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

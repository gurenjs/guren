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
 * The format new hashes are written in. `scrypt` is `node:crypto`'s and verifies
 * on every runtime; `argon2` is `Bun.password`'s and needs Bun to read back.
 */
export type PasswordHashAlgorithm = 'scrypt' | 'argon2'

export interface DefaultHasherOptions {
  /** Defaults to `scrypt`. */
  algorithm?: PasswordHashAlgorithm
}

/**
 * The hasher behind `Hash`, the default for `AuthenticatableModel` and
 * `ModelUserProvider`. Writes the configured algorithm, scrypt unless told
 * otherwise, so a row seeded under Bun still verifies on Node or Workers.
 * Verification routes on the stored hash, not the writer: `$scrypt$` verifies
 * anywhere, Argon2id/bcrypt needs `Bun.password`; the other format reports `needsRehash()`.
 */
export class DefaultHasher implements PasswordHasher {
  readonly algorithm: PasswordHashAlgorithm
  private readonly bun: ScryptHasher | null
  private readonly node: NodeHasher
  private readonly writer: ScryptHasher | NodeHasher
  private readonly testing: ScryptHasher | NodeHasher

  constructor(options: DefaultHasherOptions = {}) {
    this.algorithm = options.algorithm ?? 'scrypt'
    const bun = typeof Bun !== 'undefined' ? new ScryptHasher() : null
    this.bun = bun
    this.node = new NodeHasher()

    if (this.algorithm === 'argon2') {
      if (!bun) {
        throw new Error(
          "The 'argon2' password hasher hashes through Bun.password, which this " +
            "runtime does not have. Use the default ('scrypt'), which works everywhere.",
        )
      }
      this.writer = bun
      this.testing = new ScryptHasher(TESTING_ARGON2_OPTIONS)
    } else {
      this.writer = this.node
      this.testing = new NodeHasher({ cost: TESTING_SCRYPT_COST })
    }
  }

  hash(plain: string): Promise<string> {
    return (testingHashCost() ? this.testing : this.writer).hash(plain)
  }

  verify(hashed: string, plain: string): Promise<boolean> {
    return this.delegateFor(hashed).verify(hashed, plain)
  }

  needsRehash(hashed: string): boolean {
    // A hash in the format the writer does not produce always needs one, whatever
    // the parameters encoded in it say: an Argon2id row under the scrypt default
    // is the row that stops verifying the day the app leaves Bun.
    const writtenByNode = hashed.startsWith(NODE_SCRYPT_PREFIX)
    const writesNode = this.algorithm === 'scrypt'
    if (writtenByNode !== writesNode) {
      return true
    }

    // A hash at the testing cost is current only while tests run. Anywhere else it
    // is a downgrade to undo (`guren tool:call --as` writes real rows), which the
    // production writer cannot see: it carries no costs to compare against.
    if (!this.testing.needsRehash(hashed)) {
      return !testingHashCost()
    }

    return this.writer.needsRehash(hashed)
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
          'cannot be verified on a runtime without Bun. Such rows are rehashed to ' +
          'scrypt on their next successful login under Bun, so log the affected ' +
          'accounts in there once (or reset their passwords) before a Node or ' +
          'Workers deploy has to read them.',
      )
    }

    return this.bun
  }
}

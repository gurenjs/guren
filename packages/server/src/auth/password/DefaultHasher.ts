import type { PasswordHasher } from './PasswordHasher'
import { ScryptHasher } from './ScryptHasher'
import { NodeHasher } from './NodeHasher'

/**
 * Runtime-detecting password hasher: uses `Bun.password` when running on Bun
 * (Argon2id by default, despite `ScryptHasher`'s name) and the Node.js
 * `crypto.scrypt` implementation otherwise (e.g. AWS Lambda on the Node
 * runtime). This is the hasher behind the `Hash` export, so code written
 * against `Hash` runs on both runtimes.
 *
 * The two runtimes produce different hash formats, so a hash written under one
 * cannot be verified under the other. That only matters for an app that moves
 * an existing password column between runtimes.
 */
export class DefaultHasher implements PasswordHasher {
  private readonly delegate: PasswordHasher

  constructor() {
    this.delegate = typeof Bun !== 'undefined' ? new ScryptHasher() : new NodeHasher()
  }

  hash(plain: string): Promise<string> {
    return this.delegate.hash(plain)
  }

  verify(hashed: string, plain: string): Promise<boolean> {
    return this.delegate.verify(hashed, plain)
  }

  /**
   * Forwarded so that `Hash` is a drop-in for the runtime-specific hashers.
   * Both delegates implement it; the optional chain keeps the contract honest
   * rather than asserting it.
   */
  needsRehash(hashed: string): boolean {
    return this.delegate.needsRehash?.(hashed) ?? false
  }
}

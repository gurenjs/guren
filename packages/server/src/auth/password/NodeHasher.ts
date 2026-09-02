import type { PasswordHasher } from './PasswordHasher'
import {
  hashPassword,
  verifyPassword,
  needsRehash,
} from '../../encryption/Hash'
import type { PasswordHashOptions } from '../../encryption/types'
import { assertVerifyArgumentOrder } from './hash-format'

export interface NodeHasherOptions {
  /** scrypt cost parameter (N). Defaults to 16384. */
  cost?: number
  /** scrypt block size (r). Defaults to 8. */
  memory?: number
  /** Salt length in bytes. Defaults to 16. */
  saltLength?: number
  /** Derived key length in bytes. Defaults to 64. */
  keyLength?: number
}

/**
 * Node.js-compatible password hasher using crypto.scrypt.
 * Use this instead of ScryptHasher when deploying to non-Bun runtimes (e.g. AWS Lambda).
 */
export class NodeHasher implements PasswordHasher {
  private readonly options: PasswordHashOptions

  constructor(options: NodeHasherOptions = {}) {
    this.options = {
      cost: options.cost,
      memory: options.memory,
      saltLength: options.saltLength,
      keyLength: options.keyLength,
    }
  }

  async hash(plain: string): Promise<string> {
    return hashPassword(plain, this.options)
  }

  async verify(hashed: string, plain: string): Promise<boolean> {
    assertVerifyArgumentOrder(hashed, plain)
    return verifyPassword(plain, hashed)
  }

  needsRehash(hashed: string): boolean {
    return needsRehash(hashed, this.options)
  }
}

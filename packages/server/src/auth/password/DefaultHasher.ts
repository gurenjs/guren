import type { PasswordHasher } from './PasswordHasher'
import { ScryptHasher } from './ScryptHasher'
import { NodeHasher } from './NodeHasher'

/**
 * Runtime-detecting password hasher: uses Bun's native scrypt implementation
 * when running on Bun, and the Node.js crypto implementation otherwise
 * (e.g. AWS Lambda on the Node runtime). This is the hasher behind the
 * `Hash` export, so code written against `Hash` runs on both runtimes.
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
}

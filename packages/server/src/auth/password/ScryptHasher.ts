import type { PasswordHasher } from './PasswordHasher'

type Argon2Algorithm = 'argon2id' | 'argon2i' | 'argon2d'
type SupportedAlgorithm = Argon2Algorithm | 'bcrypt'

export interface BunPasswordHasherOptions {
  /**
   * Hashing algorithm to use. Defaults to Bun's Argon2id implementation.
   */
  algorithm?: SupportedAlgorithm
  /** Argon2 memory cost (in kibibytes). */
  memoryCost?: number
  /** Argon2 time cost (number of iterations). */
  timeCost?: number
  /** Bcrypt cost factor (log rounds). */
  cost?: number
}

/**
 * @deprecated Use {@link BunPasswordHasherOptions} for configuration.
 */
export type ScryptHasherOptions = BunPasswordHasherOptions

export class ScryptHasher implements PasswordHasher {
  private readonly algorithm: SupportedAlgorithm
  private readonly memoryCost?: number
  private readonly timeCost?: number
  private readonly cost?: number

  constructor(options: BunPasswordHasherOptions = {}) {
    this.algorithm = options.algorithm ?? 'argon2id'
    this.memoryCost = options.memoryCost
    this.timeCost = options.timeCost
    this.cost = options.cost
  }

  async hash(plain: string): Promise<string> {
    if (this.algorithm === 'bcrypt') {
      return Bun.password.hash(plain, {
        algorithm: 'bcrypt',
        cost: this.cost,
      })
    }

    return Bun.password.hash(plain, {
      algorithm: this.algorithm,
      memoryCost: this.memoryCost,
      timeCost: this.timeCost,
    })
  }

  async verify(hashed: string, plain: string): Promise<boolean> {
    return Bun.password.verify(plain, hashed)
  }

  needsRehash(hashed: string): boolean {
    if (this.algorithm === 'bcrypt') {
      if (!hashed.startsWith('$2')) {
        return true
      }

      if (this.cost != null) {
        const costSegment = hashed.slice(4, 6)
        const parsedCost = Number.parseInt(costSegment, 10)
        if (!Number.isNaN(parsedCost) && parsedCost !== this.cost) {
          return true
        }
      }

      return false
    }

    if (!hashed.startsWith(`$${this.algorithm}$`)) {
      return true
    }

    const [, , , parameterSegment] = hashed.split('$')
    if (!parameterSegment) {
      return false
    }

    const params = Object.fromEntries(
      parameterSegment
        .split(',')
        .map((pair) => pair.split('='))
        .filter((parts) => parts.length === 2) as Array<[string, string]>,
    )

    if (this.memoryCost != null) {
      const memory = Number(params.m)
      if (!Number.isNaN(memory) && memory !== this.memoryCost) {
        return true
      }
    }

    if (this.timeCost != null) {
      const time = Number(params.t)
      if (!Number.isNaN(time) && time !== this.timeCost) {
        return true
      }
    }

    return false
  }
}

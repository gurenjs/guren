export interface PasswordHasher {
  hash(plain: string): Promise<string>

  /**
   * Checks a plaintext password against a stored hash.
   *
   * **The stored hash comes first.** This order is the inverse of both
   * `Bun.password.verify(plain, hashed)` (which `ScryptHasher` delegates to)
   * and `verifyPassword(plain, hashed)` (exported from this package's
   * `encryption/Hash`), so the two conventions coexist in one codebase.
   *
   * Both parameters are `string`, so a swapped call type-checks. The built-in
   * hashers detect the obvious case at runtime and throw a `TypeError` naming
   * the order; a custom implementation gets no such help.
   *
   * @param hashed - The stored password hash, e.g. from a `passwordHash` column.
   * @param plain - The plaintext password supplied by the request.
   */
  verify(hashed: string, plain: string): Promise<boolean>

  needsRehash?(hashed: string): boolean
}

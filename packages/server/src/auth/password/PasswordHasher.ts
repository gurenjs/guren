export interface PasswordHasher {
  hash(plain: string): Promise<string>

  /**
   * Checks a plaintext password against a stored hash.
   *
   * **The stored hash comes first** — the inverse of `Bun.password.verify(plain,
   * hashed)` and of `verifyPassword(plain, hashed)`, so both conventions live in
   * one codebase. Both parameters are `string`, so a swapped call type-checks;
   * the built-in hashers throw a `TypeError` naming the order, a custom
   * implementation gets no such help.
   *
   * @param hashed - The stored password hash, e.g. from a `passwordHash` column.
   * @param plain - The plaintext password supplied by the request.
   */
  verify(hashed: string, plain: string): Promise<boolean>

  needsRehash?(hashed: string): boolean
}

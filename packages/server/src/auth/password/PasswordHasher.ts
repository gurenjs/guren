export interface PasswordHasher {
  hash(plain: string): Promise<string>

  /**
   * Checks a plaintext password against a stored hash. **The stored hash comes
   * first** — the inverse of `Bun.password.verify(plain, hashed)` and of
   * `verifyPassword(plain, hashed)`, so both conventions live in one codebase.
   * Both parameters are `string`, so a swapped call type-checks; the built-in
   * hashers throw a `TypeError` naming the order, a custom one gets no such help.
   */
  verify(hashed: string, plain: string): Promise<boolean>

  needsRehash?(hashed: string): boolean
}

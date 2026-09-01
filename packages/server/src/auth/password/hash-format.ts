/**
 * Prefixes of every hash format the built-in hashers produce: Bun's argon2
 * family (`$argon2id$`, `$argon2i$`, `$argon2d$`), bcrypt (`$2a$`, `$2b$`,
 * `$2y$`), and the Node fallback's scrypt (`$scrypt$`).
 *
 * This is a *shape* test, not a validity test. It answers "could this string
 * be a password hash at all", which is all the argument-order check below
 * needs; whether the hash is well-formed stays the underlying
 * implementation's job.
 */
const HASH_PREFIXES = ['$argon2', '$2', '$scrypt$']

export function looksLikePasswordHash(value: string): boolean {
  return HASH_PREFIXES.some((prefix) => value.startsWith(prefix))
}

/**
 * Throws when `verify()` was called as `verify(plain, hashed)`.
 *
 * `PasswordHasher.verify(hashed, plain)` takes two same-typed strings in the
 * inverse order of both `Bun.password.verify(plain, hashed)` (which
 * `ScryptHasher` delegates to) and `verifyPassword(plain, hashed)` (this
 * package's own public export), so a swapped call is a type-correct program
 * that no compiler can reject. Without this check it surfaces as an opaque
 * `UnsupportedAlgorithm` or `Invalid password hash format.` at runtime, which
 * names neither the parameter nor the order.
 *
 * The test is deliberately two-sided: it fires only when the second argument
 * looks like a hash *and* the first does not. A one-sided "the first argument
 * must look like a hash" precondition would misdiagnose a legitimate
 * non-hash credential column - `passwordHash: 'oauth:...'`, the sentinel this
 * repo documents for OAuth-only accounts - as a caller mistake. Those keep
 * falling through to the implementation, which rejects them as before.
 *
 * Neither argument is included in the message: one of them is a plaintext
 * password, and this throw is reached on a live login attempt.
 */
export function assertVerifyArgumentOrder(hashed: string, plain: string): void {
  if (looksLikePasswordHash(hashed) || !looksLikePasswordHash(plain)) {
    return
  }

  throw new TypeError(
    'PasswordHasher.verify(hashed, plain) received its arguments in the wrong ' +
      'order: the second argument looks like a password hash and the first ' +
      'does not. Note this order is the inverse of Bun.password.verify(plain, ' +
      'hashed) and of verifyPassword(plain, hashed).',
  )
}

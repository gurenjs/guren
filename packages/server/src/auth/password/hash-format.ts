/** The prefix every hash `NodeHasher` (and `hashPassword()`) writes. */
export const NODE_SCRYPT_PREFIX = '$scrypt$'

/**
 * Prefixes of every hash format the built-in hashers produce: Bun's argon2
 * family, bcrypt, and the Node fallback's scrypt.
 *
 * A *shape* test, not a validity test. Full prefixes rather than the `$argon2`
 * / `$2` stems they share: a password of `$2fast4u` is not bcrypt, and treating
 * it as one turns a correct call into a false accusation.
 */
const HASH_PREFIXES = [
  '$argon2id$',
  '$argon2i$',
  '$argon2d$',
  '$2a$',
  '$2b$',
  '$2y$',
  NODE_SCRYPT_PREFIX,
]

export function looksLikePasswordHash(value: string): boolean {
  return HASH_PREFIXES.some((prefix) => value.startsWith(prefix))
}

/**
 * Throws when `verify()` was called as `verify(plain, hashed)`.
 *
 * Two-sided on purpose: it fires only when the second argument looks like a
 * hash *and* the first does not. A one-sided precondition would misdiagnose a
 * legitimate non-hash credential column (`passwordHash: 'oauth:...'`) as a
 * caller mistake. Neither argument is in the message: one of them is a
 * plaintext password, on a live login attempt.
 */
export function assertVerifyArgumentOrder(hashed: string, plain: string): void {
  if (!looksLikePasswordHash(hashed) && looksLikePasswordHash(plain)) {
    throw new TypeError(
      'PasswordHasher.verify(hashed, plain) received its arguments in the wrong ' +
        'order: the second argument looks like a password hash and the first ' +
        'does not. Note this order is the inverse of Bun.password.verify(plain, ' +
        'hashed) and of verifyPassword(plain, hashed).',
    )
  }
}

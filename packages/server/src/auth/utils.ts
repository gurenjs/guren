import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

/**
 * Hash a token using SHA-256 or SHA-512.
 */
export function hashToken(token: string, algorithm: 'sha256' | 'sha512' = 'sha256'): string {
  return createHash(algorithm).update(token).digest('hex')
}

/**
 * Generate a secure random token.
 */
export function generateToken(length: number = 32): string {
  return randomBytes(length).toString('hex')
}

/**
 * Generate a random ID (16 bytes = 32 hex chars).
 */
export function generateId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Securely compare two hex strings using timing-safe comparison.
 *
 * Input that is not strict, even-length hex is rejected rather than compared:
 * `Buffer.from(value, 'hex')` stops at the first invalid pair, so 'zzzz' and
 * 'yyyy' both decode to nothing — and 'abcz' and 'abdz' both decode to the
 * one byte they share — and would compare equal. A short decode is how the
 * decoder reports that, which beats restating its grammar in a regex here.
 * Use `secureStringCompare` for values that are not hex.
 */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false

  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== a.length / 2 || bufB.length !== b.length / 2) return false

  return timingSafeEqual(bufA, bufB)
}

/**
 * Securely compare two arbitrary strings using timing-safe comparison.
 * Unlike secureCompare, this works with any string encoding (UUIDs, tokens, etc.).
 */
export function secureStringCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Build a URL with token and optional email parameters.
 */
export function buildTokenUrl(baseUrl: string, token: string, email?: string): string {
  const url = new URL(baseUrl)
  url.searchParams.set('token', token)
  if (email) {
    url.searchParams.set('email', email)
  }
  return url.toString()
}

/**
 * Parse a URL to extract token and email parameters.
 */
export function parseTokenUrl(url: string): { token: string | null; email: string | null } {
  try {
    const parsed = new URL(url)
    return {
      token: parsed.searchParams.get('token'),
      email: parsed.searchParams.get('email'),
    }
  } catch {
    return { token: null, email: null }
  }
}

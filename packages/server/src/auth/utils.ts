import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

export function hashToken(token: string, algorithm: 'sha256' | 'sha512' = 'sha256'): string {
  return createHash(algorithm).update(token).digest('hex')
}

export function generateToken(length: number = 32): string {
  return randomBytes(length).toString('hex')
}

/** Generate a random ID (16 bytes = 32 hex chars). */
export function generateId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Timing-safe comparison of two hex strings. Non-hex or odd-length input is
 * rejected rather than compared: `Buffer.from(x, 'hex')` stops at the first
 * invalid pair, so 'zzzz' and 'yyyy' would both decode to nothing and compare
 * equal. Use `secureStringCompare` for values that are not hex.
 */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false

  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== a.length / 2 || bufB.length !== b.length / 2) return false

  return timingSafeEqual(bufA, bufB)
}

/** Timing-safe comparison for arbitrary strings — unlike secureCompare, not hex-only. */
export function secureStringCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function buildTokenUrl(baseUrl: string, token: string, email?: string): string {
  const url = new URL(baseUrl)
  url.searchParams.set('token', token)
  if (email) {
    url.searchParams.set('email', email)
  }
  return url.toString()
}

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

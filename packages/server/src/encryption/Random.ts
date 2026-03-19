import { randomBytes, randomUUID, randomInt as cryptoRandomInt } from 'crypto'
import type { RandomStringOptions } from './types'

/**
 * Character sets for random string generation.
 */
const CHARSETS = {
  alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  alphabetic: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  numeric: '0123456789',
  hex: '0123456789abcdef',
  'base64': 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  'url-safe': 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
} as const

/**
 * Generate a cryptographically secure random string.
 *
 * @example
 * ```typescript
 * randomString(32) // 32-character alphanumeric string
 * randomString(16, { charset: 'hex' }) // 16-character hex string
 * randomString(24, { charset: 'url-safe' }) // URL-safe string
 * ```
 */
export function randomString(
  length: number,
  options: RandomStringOptions = {}
): string {
  const { charset = 'alphanumeric' } = options
  const chars = CHARSETS[charset]
  const bytes = randomBytes(length)
  let result = ''

  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length]
  }

  return result
}

/**
 * Generate random bytes.
 *
 * @example
 * ```typescript
 * const bytes = random(32) // 32 random bytes
 * ```
 */
export function random(length: number): Buffer {
  return randomBytes(length)
}

/**
 * Generate random bytes as hex string.
 */
export function randomHex(length: number): string {
  return randomBytes(length).toString('hex')
}

/**
 * Generate random bytes as base64 string.
 */
export function randomBase64(length: number): string {
  return randomBytes(length).toString('base64')
}

/**
 * Generate random bytes as URL-safe base64 string.
 */
export function randomBase64Url(length: number): string {
  return randomBytes(length)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

/**
 * Generate a UUID v4.
 *
 * @example
 * ```typescript
 * const id = uuid() // e.g., '550e8400-e29b-41d4-a716-446655440000'
 * ```
 */
export function uuid(): string {
  return randomUUID()
}

/**
 * Generate a secure random integer.
 *
 * @example
 * ```typescript
 * randomInt(1, 100) // Random number between 1 and 100 (inclusive)
 * ```
 */
export function randomInt(min: number, max: number): number {
  return cryptoRandomInt(min, max + 1)
}

/**
 * Generate a random token suitable for URLs.
 *
 * @example
 * ```typescript
 * const token = urlSafeToken(32) // URL-safe 32-character token
 * ```
 */
export function urlSafeToken(length: number = 32): string {
  return randomBase64Url(Math.ceil(length * 0.75)).slice(0, length)
}

/**
 * Generate a secure random password.
 *
 * @example
 * ```typescript
 * const password = generatePassword(16) // Random 16-character password
 * ```
 */
export function generatePassword(
  length: number = 16,
  options: {
    uppercase?: boolean
    lowercase?: boolean
    numbers?: boolean
    symbols?: boolean
  } = {}
): string {
  const {
    uppercase = true,
    lowercase = true,
    numbers = true,
    symbols = true,
  } = options

  let chars = ''
  if (uppercase) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  if (lowercase) chars += 'abcdefghijklmnopqrstuvwxyz'
  if (numbers) chars += '0123456789'
  if (symbols) chars += '!@#$%^&*()-_=+[]{}|;:,.<>?'

  if (chars.length === 0) {
    chars = CHARSETS.alphanumeric
  }

  const bytes = randomBytes(length)
  let result = ''

  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length]
  }

  return result
}

/**
 * Generate a random OTP (One-Time Password).
 *
 * @example
 * ```typescript
 * const otp = generateOtp(6) // e.g., '482901'
 * ```
 */
export function generateOtp(length: number = 6): string {
  return randomString(length, { charset: 'numeric' })
}

/**
 * Generate a random slug-friendly string.
 *
 * @example
 * ```typescript
 * const slug = generateSlug() // e.g., 'a8b2c4d6e8'
 * ```
 */
export function generateSlug(length: number = 10): string {
  return randomString(length, { charset: 'hex' })
}

/**
 * Shuffle an array using Fisher-Yates algorithm with secure random.
 *
 * @example
 * ```typescript
 * const shuffled = shuffle([1, 2, 3, 4, 5])
 * ```
 */
export function shuffle<T>(array: T[]): T[] {
  const result = [...array]

  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(0, i)
    ;[result[i], result[j]] = [result[j], result[i]]
  }

  return result
}

/**
 * Pick a random element from an array.
 *
 * @example
 * ```typescript
 * const item = pick(['a', 'b', 'c']) // Random element
 * ```
 */
export function pick<T>(array: T[]): T {
  if (array.length === 0) {
    throw new Error('Cannot pick from empty array.')
  }
  return array[randomInt(0, array.length - 1)]
}

/**
 * Pick multiple random elements from an array.
 *
 * @example
 * ```typescript
 * const items = sample(['a', 'b', 'c', 'd'], 2) // Two random elements
 * ```
 */
export function sample<T>(array: T[], count: number): T[] {
  if (count > array.length) {
    throw new Error('Sample count exceeds array length.')
  }

  const shuffled = shuffle(array)
  return shuffled.slice(0, count)
}

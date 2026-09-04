import { randomBytes, randomUUID, randomInt as cryptoRandomInt } from 'crypto'
import type { RandomStringOptions } from './types'

const CHARSETS = {
  alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  alphabetic: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  numeric: '0123456789',
  hex: '0123456789abcdef',
  'base64': 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  'url-safe': 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
} as const

/**
 * Maps random bytes onto a character set without modulo bias: bytes above the
 * largest multiple of `chars.length` under 256 are discarded and redrawn, so
 * every character stays equally likely.
 */
function unbiasedRandomChars(length: number, chars: string): string {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`Random string length must be a non-negative integer, received ${length}.`)
  }

  const limit = 256 - (256 % chars.length)
  let result = ''

  while (result.length < length) {
    // Over-draw by the expected rejection rate so a second draw stays rare.
    const remaining = length - result.length
    const bytes = randomBytes(Math.ceil((remaining * 256) / limit) + 8)
    for (const byte of bytes) {
      if (byte < limit) {
        result += chars[byte % chars.length]
        if (result.length === length) break
      }
    }
  }

  return result
}

/** Cryptographically secure random string. */
export function randomString(
  length: number,
  options: RandomStringOptions = {}
): string {
  const { charset = 'alphanumeric' } = options
  return unbiasedRandomChars(length, CHARSETS[charset])
}

/** Cryptographically secure random bytes. */
export function random(length: number): Buffer {
  return randomBytes(length)
}

export function randomHex(length: number): string {
  return randomBytes(length).toString('hex')
}

export function randomBase64(length: number): string {
  return randomBytes(length).toString('base64')
}

export function randomBase64Url(length: number): string {
  return randomBytes(length)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

export function uuid(): string {
  return randomUUID()
}

/** Secure random integer in `[min, max]` — `max` is inclusive. */
export function randomInt(min: number, max: number): number {
  return cryptoRandomInt(min, max + 1)
}

/** URL-safe token of exactly `length` characters. */
export function urlSafeToken(length: number = 32): string {
  return randomBase64Url(Math.ceil(length * 0.75)).slice(0, length)
}

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

  return unbiasedRandomChars(length, chars)
}

/** One-time password. */
export function generateOtp(length: number = 6): string {
  return randomString(length, { charset: 'numeric' })
}

export function generateSlug(length: number = 10): string {
  return randomString(length, { charset: 'hex' })
}

/** Fisher-Yates, drawing from the secure source. */
export function shuffle<T>(array: T[]): T[] {
  const result = [...array]

  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(0, i)
    ;[result[i], result[j]] = [result[j], result[i]]
  }

  return result
}

export function pick<T>(array: T[]): T {
  if (array.length === 0) {
    throw new Error('Cannot pick from empty array.')
  }
  return array[randomInt(0, array.length - 1)]
}

export function sample<T>(array: T[], count: number): T[] {
  if (count > array.length) {
    throw new Error('Sample count exceeds array length.')
  }

  const shuffled = shuffle(array)
  return shuffled.slice(0, count)
}

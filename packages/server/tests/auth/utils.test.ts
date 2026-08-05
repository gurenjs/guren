import { describe, test, expect } from 'bun:test'
import {
  hashToken,
  generateToken,
  generateId,
  secureCompare,
  secureStringCompare,
  buildTokenUrl,
  parseTokenUrl,
} from '../../src/auth/utils'

describe('auth/utils', () => {
  describe('hashToken', () => {
    test('should return a SHA-256 hex string by default', () => {
      const hash = hashToken('my-token')
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
    })

    test('should produce deterministic output', () => {
      expect(hashToken('hello')).toBe(hashToken('hello'))
    })

    test('should produce different hashes for different inputs', () => {
      expect(hashToken('a')).not.toBe(hashToken('b'))
    })

    test('should support SHA-512', () => {
      const hash = hashToken('my-token', 'sha512')
      expect(hash).toMatch(/^[0-9a-f]{128}$/)
    })

    test('should produce different results for different algorithms', () => {
      expect(hashToken('token', 'sha256')).not.toBe(hashToken('token', 'sha512'))
    })
  })

  describe('generateToken', () => {
    test('should return a 64-char hex string by default (32 bytes)', () => {
      const token = generateToken()
      expect(token).toMatch(/^[0-9a-f]{64}$/)
    })

    test('should respect custom length', () => {
      const token = generateToken(16)
      expect(token).toMatch(/^[0-9a-f]{32}$/)
    })

    test('should produce unique tokens', () => {
      const a = generateToken()
      const b = generateToken()
      expect(a).not.toBe(b)
    })
  })

  describe('generateId', () => {
    test('should return a 32-char hex string', () => {
      const id = generateId()
      expect(id).toMatch(/^[0-9a-f]{32}$/)
    })

    test('should produce unique IDs', () => {
      const a = generateId()
      const b = generateId()
      expect(a).not.toBe(b)
    })
  })

  describe('secureCompare', () => {
    test('should return true for identical hex strings', () => {
      const hash = hashToken('test')
      expect(secureCompare(hash, hash)).toBe(true)
    })

    test('should return false for different hex strings', () => {
      const a = hashToken('a')
      const b = hashToken('b')
      expect(secureCompare(a, b)).toBe(false)
    })

    test('should return false for different lengths', () => {
      expect(secureCompare('aa', 'aabb')).toBe(false)
    })

    test('should return true for matching empty strings (zero-length buffers)', () => {
      // timingSafeEqual with zero-length buffers returns true
      expect(secureCompare('', '')).toBe(true)
    })

    test('should return false for different non-hex strings that decode alike', () => {
      // Buffer.from(value, 'hex') stops at the first invalid pair, so both of
      // these would decode to the same empty buffer and compare equal.
      expect(secureCompare('zzzz', 'yyyy')).toBe(false)
      expect(secureCompare('g0000000', 'z0000000')).toBe(false)
    })

    test('should return false when a shared hex prefix precedes invalid input', () => {
      expect(secureCompare('abcz', 'abdz')).toBe(false)
    })

    test('should return false for odd-length hex that truncates to a shared byte', () => {
      // Both decode to the single byte 0xab without the strict-length check.
      expect(secureCompare('abc', 'abd')).toBe(false)
      expect(secureCompare('abc', 'abc')).toBe(false)
    })
  })

  describe('secureStringCompare', () => {
    test('should return true for identical strings', () => {
      expect(secureStringCompare('hello-world', 'hello-world')).toBe(true)
    })

    test('should return false for different strings', () => {
      expect(secureStringCompare('hello', 'world')).toBe(false)
    })

    test('should return false for different lengths', () => {
      expect(secureStringCompare('short', 'longer-string')).toBe(false)
    })

    test('should work with UUIDs', () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
      expect(secureStringCompare(uuid, uuid)).toBe(true)
      expect(secureStringCompare(uuid, 'a1b2c3d4-e5f6-7890-abcd-ef1234567891')).toBe(false)
    })

    test('should return true for empty strings', () => {
      expect(secureStringCompare('', '')).toBe(true)
    })
  })

  describe('buildTokenUrl', () => {
    test('should append token parameter', () => {
      const url = buildTokenUrl('https://example.com/reset', 'abc123')
      expect(url).toBe('https://example.com/reset?token=abc123')
    })

    test('should append email when provided', () => {
      const url = buildTokenUrl('https://example.com/reset', 'abc123', 'user@test.com')
      const parsed = new URL(url)
      expect(parsed.searchParams.get('token')).toBe('abc123')
      expect(parsed.searchParams.get('email')).toBe('user@test.com')
    })

    test('should not include email when not provided', () => {
      const url = buildTokenUrl('https://example.com/reset', 'abc123')
      const parsed = new URL(url)
      expect(parsed.searchParams.has('email')).toBe(false)
    })
  })

  describe('parseTokenUrl', () => {
    test('should extract token and email', () => {
      const result = parseTokenUrl('https://example.com/reset?token=abc&email=user@test.com')
      expect(result.token).toBe('abc')
      expect(result.email).toBe('user@test.com')
    })

    test('should return null for missing params', () => {
      const result = parseTokenUrl('https://example.com/reset')
      expect(result.token).toBeNull()
      expect(result.email).toBeNull()
    })

    test('should return nulls for invalid URL', () => {
      const result = parseTokenUrl('not-a-url')
      expect(result.token).toBeNull()
      expect(result.email).toBeNull()
    })
  })
})

import { describe, expect, it } from 'vitest'
import {
  assertAllowlistedAdmin,
  isAllowlistedAdmin,
} from './admin-allowlist.js'

describe('isAllowlistedAdmin', () => {
  it('should accept the allowlisted GitHub id', () => {
    expect(isAllowlistedAdmin('12345', '12345')).toBe(true)
  })

  it('should reject any other GitHub id', () => {
    expect(isAllowlistedAdmin('99999', '12345')).toBe(false)
  })

  it('should accept anyone when the allowlist is unset or blank', () => {
    expect(isAllowlistedAdmin('99999', undefined)).toBe(true)
    expect(isAllowlistedAdmin('99999', '')).toBe(true)
    expect(isAllowlistedAdmin('99999', '   ')).toBe(true)
  })

  it('should tolerate surrounding whitespace in the configured id', () => {
    expect(isAllowlistedAdmin('12345', ' 12345 ')).toBe(true)
  })
})

describe('assertAllowlistedAdmin', () => {
  it('should throw a 403 for a non-allowlisted id', () => {
    try {
      assertAllowlistedAdmin('99999', '12345')
      expect.unreachable('expected assertAllowlistedAdmin to throw')
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(403)
    }
  })

  it('should not throw for the allowlisted id', () => {
    expect(() => assertAllowlistedAdmin('12345', '12345')).not.toThrow()
  })

  it('should reject every account in production when the allowlist is unset', () => {
    // An env var missed during deployment must not hand post management to
    // whoever signs in first.
    expect(isAllowlistedAdmin('12345', undefined, true)).toBe(false)
    expect(isAllowlistedAdmin('12345', '  ', true)).toBe(false)
    expect(() => assertAllowlistedAdmin('12345', undefined, true)).toThrow()
  })

  it('should accept any account outside production when the allowlist is unset', () => {
    expect(isAllowlistedAdmin('12345', undefined, false)).toBe(true)
  })
})

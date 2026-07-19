import { describe, test, expect } from 'bun:test'
import { ModelUserProvider } from '../../src/auth/providers/ModelUserProvider'
import type { Sanitized } from '../../src/auth/types'

interface UserRecord {
  id: number
  email: string
  passwordHash: string
  rememberToken: string | null
  twoFactorSecret: string
}

describe('Sanitized<T>', () => {
  test('strips default credential keys and extra hidden keys at the type level', () => {
    const safe: Sanitized<UserRecord, 'twoFactorSecret'> = {
      id: 1,
      email: 'user@example.com',
    }

    // @ts-expect-error passwordHash is stripped by sanitization
    void safe.passwordHash
    // @ts-expect-error rememberToken is stripped by sanitization
    void safe.rememberToken
    // @ts-expect-error twoFactorSecret is stripped via the Hidden parameter
    void safe.twoFactorSecret

    expect(safe.id).toBe(1)
    expect(safe.email).toBe('user@example.com')
  })

  test('distributes over union record types', () => {
    type Admin = { kind: 'admin'; email: string; password: string }
    type Customer = { kind: 'customer'; phone: string; password: string }

    const admin: Sanitized<Admin | Customer> = { kind: 'admin', email: 'a@example.com' }
    const customer: Sanitized<Admin | Customer> = { kind: 'customer', phone: '555' }

    // Member-specific safe fields survive after narrowing.
    if (admin.kind === 'admin') {
      expect(admin.email).toBe('a@example.com')
    }
    if (customer.kind === 'customer') {
      expect(customer.phone).toBe('555')
    }
  })

  test('matches what ModelUserProvider.sanitize() strips at runtime', () => {
    class FakeUserModel {
      static hidden = ['twoFactorSecret']
    }

    const provider = new ModelUserProvider(FakeUserModel as never, {
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
    })

    const sanitized = provider.sanitize({
      id: 1,
      email: 'user@example.com',
      passwordHash: 'hashed',
      rememberToken: 'token',
      twoFactorSecret: 'otp-secret',
    } as never) as unknown as Record<string, unknown>

    // The runtime result carries exactly the keys Sanitized<UserRecord, 'twoFactorSecret'> keeps.
    expect(Object.keys(sanitized).sort()).toEqual(['email', 'id'])
  })
})

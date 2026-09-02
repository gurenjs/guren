import { describe, test, expect } from 'bun:test'
import { ModelUserProvider } from '../../src/auth/providers/ModelUserProvider'
import { NodeHasher } from '../../src/auth/password/NodeHasher'
import type { PasswordHasher } from '../../src/auth/password/PasswordHasher'

type Row = { id: number; email: string; passwordHash: unknown }

function providerFor(rows: Row[], hasher?: PasswordHasher) {
  const model = {
    where: async (clause: Record<string, unknown>) =>
      rows.filter((row) => row.email === clause.email),
  }

  return new ModelUserProvider(model as never, {
    usernameColumn: 'email',
    passwordColumn: 'passwordHash',
    credentialsPasswordField: 'password',
    ...(hasher ? { hasher } : {}),
  })
}

// A password login against an account that has no password used to reach the
// hasher, which throws. The 500 that produced told an attacker the address
// belonged to an OAuth account, while an unknown address answered 401.
describe('a credential column that is not a password hash', () => {
  const PASSWORDLESS = {
    'the sentinel this repo documents': 'oauth:github:12345',
    'a bare provider name': 'oauth',
    'an empty string': '',
    'null': null,
    'undefined': undefined,
    'a number left by a bad migration': 12345,
  }

  test.each(Object.entries(PASSWORDLESS))('denies the login for %s', async (_label, passwordHash) => {
    const provider = providerFor([{ id: 1, email: 'a@example.com', passwordHash }])
    const user = { id: 1, email: 'a@example.com', passwordHash }

    expect(await provider.validateCredentials(user as never, { password: 'guess' })).toBe(false)
  })

  test('spends the same hashing work as a real verification', async () => {
    // Without the dummy hash the sentinel would return in microseconds while a
    // real account pays for scrypt, which is the same enumeration channel
    // measured with a stopwatch instead of read off a status code.
    const calls: string[] = []
    const counting: PasswordHasher = {
      async hash(plain) {
        calls.push(plain)
        return new NodeHasher({ cost: 1024 }).hash(plain)
      },
      verify: (hashed, plain) => new NodeHasher({ cost: 1024 }).verify(hashed, plain),
    }

    const provider = providerFor([], counting)
    const user = { id: 1, email: 'a@example.com', passwordHash: 'oauth:github:12345' }

    expect(await provider.validateCredentials(user as never, { password: 'guess' })).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

// The other half of the rule: a value that claims a hash format and does not
// satisfy it is a corrupt column, and denying it in silence would leave nothing
// to notice it by.
describe('a credential column that claims a hash format', () => {
  const CORRUPT = {
    'a truncated digest': '$scrypt$N=1024,r=8,p=1$c2FsdA==$',
    'unparseable parameters': '$scrypt$N=x,r=y,p=z$c2FsdA==$c2FsdA==',
    'a bcrypt prefix with no body': '$2b$',
  }

  test.each(Object.entries(CORRUPT))('still throws for %s', async (_label, passwordHash) => {
    const provider = providerFor([{ id: 1, email: 'a@example.com', passwordHash }])
    const user = { id: 1, email: 'a@example.com', passwordHash }

    await expect(provider.validateCredentials(user as never, { password: 'guess' })).rejects.toThrow()
  })
})

describe('a real password hash', () => {
  test('is unaffected', async () => {
    const hasher = new NodeHasher({ cost: 1024 })
    const passwordHash = await hasher.hash('password123')
    const provider = providerFor([{ id: 1, email: 'a@example.com', passwordHash }], hasher)
    const user = { id: 1, email: 'a@example.com', passwordHash }

    expect(await provider.validateCredentials(user as never, { password: 'password123' })).toBe(true)
    expect(await provider.validateCredentials(user as never, { password: 'wrong' })).toBe(false)
  })
})

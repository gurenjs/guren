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

// Reaching the hasher here throws, and that 500 tells an attacker the address belongs to
// an OAuth account while an unknown address answers 401.
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
    // Without the dummy hash the sentinel returns in microseconds while a real account pays
    // for scrypt: the same enumeration channel, measured with a stopwatch.
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

// A value that claims a hash format and does not satisfy it is a corrupt column, and
// denying it in silence would leave nothing to notice it by.
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

// An address no record holds pays the verify a known one pays, or the response
// time says which addresses have accounts.
describe('a login for an address no record holds', () => {
  function countingHasher() {
    const real = new NodeHasher({ cost: 1024 })
    const hashed: string[] = []
    const verified: Array<[string, string]> = []
    const hasher: PasswordHasher = {
      async hash(plain) {
        const result = await real.hash(plain)
        hashed.push(result)
        return result
      },
      async verify(stored, plain) {
        verified.push([stored, plain])
        return real.verify(stored, plain)
      },
    }
    return { hasher, hashed, verified }
  }

  test('verifies the submitted password against one dummy hash per hasher', async () => {
    const { hasher, hashed, verified } = countingHasher()
    const provider = providerFor([], hasher)

    await provider.verifyMissingUser({ email: 'nobody@example.com', password: 'first' })
    await provider.verifyMissingUser({ email: 'nobody@example.com', password: 'second' })

    expect(hashed).toHaveLength(1)
    expect(verified).toEqual([
      [hashed[0]!, 'first'],
      [hashed[0]!, 'second'],
    ])
  })

  test('hashes the dummy once when the first two logins arrive together', async () => {
    const { hasher, hashed, verified } = countingHasher()
    const provider = providerFor([], hasher)

    await Promise.all([
      provider.verifyMissingUser({ email: 'a@example.com', password: 'one' }),
      provider.verifyMissingUser({ email: 'b@example.com', password: 'two' }),
    ])

    expect(hashed).toHaveLength(1)
    expect(verified).toHaveLength(2)
  })

  test('keeps a separate dummy for each hasher', async () => {
    const first = countingHasher()
    const second = countingHasher()

    await providerFor([], first.hasher).verifyMissingUser({ email: 'a@example.com', password: 'x' })
    await providerFor([], second.hasher).verifyMissingUser({ email: 'a@example.com', password: 'x' })

    expect(first.hashed).toHaveLength(1)
    expect(second.hashed).toHaveLength(1)
    expect(second.verified[0]![0]).toBe(second.hashed[0]!)
  })

  test('skips the hasher for a password that is not a string, as a known address does', async () => {
    const { hasher, hashed, verified } = countingHasher()
    const provider = providerFor([], hasher)

    await provider.verifyMissingUser({ email: 'nobody@example.com', password: 12345 })

    expect(hashed).toHaveLength(0)
    expect(verified).toHaveLength(0)
  })

  test('hashes again after a dummy hash that failed', async () => {
    let attempts = 0
    const real = new NodeHasher({ cost: 1024 })
    const flaky: PasswordHasher = {
      async hash(plain) {
        attempts += 1
        if (attempts === 1) throw new Error('hasher unavailable')
        return real.hash(plain)
      },
      verify: (stored, plain) => real.verify(stored, plain),
    }
    const provider = providerFor([], flaky)

    await expect(provider.verifyMissingUser({ email: 'a@example.com', password: 'x' })).rejects.toThrow('hasher unavailable')
    await provider.verifyMissingUser({ email: 'a@example.com', password: 'x' })

    expect(attempts).toBe(2)
  })
})

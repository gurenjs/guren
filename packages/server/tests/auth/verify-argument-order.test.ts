import { describe, test, expect } from 'bun:test'
import { ScryptHasher } from '../../src/auth/password/ScryptHasher'
import { NodeHasher } from '../../src/auth/password/NodeHasher'
import { DefaultHasher } from '../../src/auth/password/DefaultHasher'
import type { PasswordHasher } from '../../src/auth/password/PasswordHasher'

// `verify(hashed, plain)` takes two same-typed strings in the inverse order of
// the `Bun.password.verify(plain, hashed)` it delegates to, so a swapped call
// is a type-correct program. It shipped in this repo's own API example and its
// suite stayed green, because the test double there encoded the same inversion.
const HASHERS: Array<[string, () => PasswordHasher]> = [
  ['ScryptHasher', () => new ScryptHasher()],
  ['ScryptHasher (bcrypt)', () => new ScryptHasher({ algorithm: 'bcrypt', cost: 4 })],
  ['NodeHasher', () => new NodeHasher({ cost: 1024 })],
  ['DefaultHasher', () => new DefaultHasher()],
]

describe.each(HASHERS)('%s', (_name, create) => {
  test('verifies a password it hashed', async () => {
    const hasher = create()
    const hashed = await hasher.hash('password123')

    expect(await hasher.verify(hashed, 'password123')).toBe(true)
    expect(await hasher.verify(hashed, 'wrong')).toBe(false)
  })

  test('names the parameter order when the arguments are swapped', async () => {
    const hasher = create()
    const hashed = await hasher.hash('password123')

    // The exact defect: verify(plain, hashed) instead of verify(hashed, plain).
    const swapped = hasher.verify('password123', hashed)

    await expect(swapped).rejects.toThrow(TypeError)
    await expect(swapped).rejects.toThrow(/wrong\s+order/)
  })

  test('does not leak either argument in the swap diagnostic', async () => {
    const hasher = create()
    const hashed = await hasher.hash('hunter2-plaintext')

    // The first argument of a swapped call is a live plaintext password, and
    // this throw is reached on a login attempt, so it must stay out of logs.
    const message = await hasher
      .verify('hunter2-plaintext', hashed)
      .then(() => '')
      .catch((error: Error) => error.message)

    expect(message).not.toContain('hunter2-plaintext')
    expect(message).not.toContain(hashed)
  })

  test('leaves a non-hash credential column to the implementation', async () => {
    const hasher = create()

    // `passwordHash: 'oauth:...'` is this repo's documented sentinel for an
    // OAuth-only account. Neither argument looks like a hash, so the swap check
    // must not fire and misdiagnose it as a caller mistake.
    const attempt = hasher.verify('oauth:github:12345', 'password123')

    await expect(attempt).rejects.not.toThrow(TypeError)
  })

  test('does not fire when the plaintext merely starts with a dollar sign', async () => {
    const hasher = create()
    const hashed = await hasher.hash('$argon2-but-actually-a-password')

    expect(await hasher.verify(hashed, '$argon2-but-actually-a-password')).toBe(true)
  })
})

import { describe, test, expect } from 'bun:test'
import { ScryptHasher } from '../../src/auth/password/ScryptHasher'
import { NodeHasher } from '../../src/auth/password/NodeHasher'
import { DefaultHasher } from '../../src/auth/password/DefaultHasher'
import type { PasswordHasher } from '../../src/auth/password/PasswordHasher'

// `verify(hashed, plain)` inverts the `Bun.password.verify(plain, hashed)` it delegates to,
// so a swapped call is a type-correct program that a test double can encode too.
// Cost parameters are the cheapest each hasher accepts; at their defaults this table
// costs ~500ms of Argon2id.
const HASHERS: Array<[string, () => PasswordHasher]> = [
  ['ScryptHasher', () => new ScryptHasher({ memoryCost: 64, timeCost: 1 })],
  ['ScryptHasher (bcrypt)', () => new ScryptHasher({ algorithm: 'bcrypt', cost: 4 })],
  ['NodeHasher', () => new NodeHasher({ cost: 1024 })],
  ['DefaultHasher', () => new DefaultHasher()],
]

describe.each(HASHERS)('%s', (_name, create) => {
  test('names the parameter order when the arguments are swapped', async () => {
    const hasher = create()
    const hashed = await hasher.hash('hunter2-plaintext')

    const swapped = hasher.verify('hunter2-plaintext', hashed)

    await expect(swapped).rejects.toThrow(TypeError)
    await expect(swapped).rejects.toThrow(/wrong\s+order/)
    // A swapped call's first argument is a live plaintext password and this throw is
    // reached on a login attempt, so it must stay out of logs.
    await expect(swapped).rejects.not.toThrow('hunter2-plaintext')
    await expect(swapped).rejects.not.toThrow(hashed)
  })

  test('leaves a non-hash credential column to the implementation', async () => {
    const hasher = create()

    // `oauth:...` is this repo's sentinel for an OAuth-only account: neither argument looks
    // like a hash, so the swap check must not misdiagnose it as a caller mistake.
    await expect(hasher.verify('oauth:github:12345', 'password123')).rejects.not.toThrow(TypeError)
  })

  // A `$argon2` / `$2` stem match would misdiagnose this: neither value is a format any
  // built-in writes, so the call is correct and must reach the implementation.
  test('does not fire on a non-hash column with a prefix-shaped password', async () => {
    const hasher = create()

    for (const password of ['$2fast4u', '$argon2-is-my-password', '$scrypt-ish']) {
      await expect(hasher.verify('oauth:github:12345', password)).rejects.not.toThrow(TypeError)
    }
  })

  test('does not fire when the plaintext merely starts with a dollar sign', async () => {
    const hasher = create()
    const hashed = await hasher.hash('$argon2-but-actually-a-password')

    expect(await hasher.verify(hashed, '$argon2-but-actually-a-password')).toBe(true)
  })
})

// `DefaultHasher` picks a delegate per *hash*, not per runtime: picking by runtime alone
// 500s on every login for a column written on the other runtime (a Bun seeder, a Node deploy).
describe('DefaultHasher cross-runtime verification', () => {
  test('verifies a hash written by the other delegate when it can', async () => {
    const nodeWritten = await new NodeHasher({ cost: 1024 }).hash('password123')
    const hasher = new DefaultHasher()

    expect(nodeWritten.startsWith('$scrypt$')).toBe(true)
    expect(await hasher.verify(nodeWritten, 'password123')).toBe(true)
    expect(await hasher.verify(nodeWritten, 'wrong')).toBe(false)
  })

  test('round-trips its own hashes', async () => {
    const hasher = new DefaultHasher()
    const hashed = await hasher.hash('password123')

    expect(await hasher.verify(hashed, 'password123')).toBe(true)
    expect(await hasher.verify(hashed, 'wrong')).toBe(false)
    expect(hasher.needsRehash(hashed)).toBe(false)
  })

  test('reports a hash it cannot reproduce as needing a rehash', async () => {
    const nodeWritten = await new NodeHasher({ cost: 1024 }).hash('password123')

    // On Bun the default writes Argon2id, so a scrypt hash is a format this process
    // cannot reproduce.
    expect(new DefaultHasher().needsRehash(nodeWritten)).toBe(typeof Bun !== 'undefined')
  })
})

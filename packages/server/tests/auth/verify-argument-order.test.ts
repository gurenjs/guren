import { describe, test, expect } from 'bun:test'
import { ScryptHasher } from '../../src/auth/password/ScryptHasher'
import { NodeHasher } from '../../src/auth/password/NodeHasher'
import { DefaultHasher } from '../../src/auth/password/DefaultHasher'
import type { PasswordHasher } from '../../src/auth/password/PasswordHasher'

// `verify(hashed, plain)` takes two same-typed strings in the inverse order of
// the `Bun.password.verify(plain, hashed)` it delegates to, so a swapped call
// is a type-correct program. It shipped in this repo's own API example and its
// suite stayed green, because the test double there encoded the same inversion.
//
// Cost parameters are the cheapest each hasher accepts: nothing here depends on
// them, and at their defaults the table costs ~500ms of Argon2id.
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

    // The exact defect: verify(plain, hashed) instead of verify(hashed, plain).
    const swapped = hasher.verify('hunter2-plaintext', hashed)

    await expect(swapped).rejects.toThrow(TypeError)
    await expect(swapped).rejects.toThrow(/wrong\s+order/)
    // The first argument of a swapped call is a live plaintext password, and
    // this throw is reached on a login attempt, so it must stay out of logs.
    await expect(swapped).rejects.not.toThrow('hunter2-plaintext')
    await expect(swapped).rejects.not.toThrow(hashed)
  })

  test('leaves a non-hash credential column to the implementation', async () => {
    const hasher = create()

    // `passwordHash: 'oauth:...'` is this repo's documented sentinel for an
    // OAuth-only account. Neither argument looks like a hash, so the swap check
    // must not fire and misdiagnose it as a caller mistake.
    await expect(hasher.verify('oauth:github:12345', 'password123')).rejects.not.toThrow(TypeError)
  })

  // The combination that a `$argon2` / `$2` stem match would misdiagnose: a
  // non-hash credential column paired with a password that merely looks
  // prefix-shaped. Neither is a format any built-in writes, so this is a
  // correct call and must reach the implementation.
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

// `DefaultHasher` picks a delegate per *hash*, not per runtime. Picking by
// runtime alone 500s on every login for an app whose password column was
// written elsewhere - a seeder run on Bun against a database a Node deploy
// serves - which is the failure this file exists to keep out.
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

    // On Bun the default hashes with Argon2id, so a scrypt hash is a format
    // this process cannot write and the parameters encoded in it are moot.
    expect(new DefaultHasher().needsRehash(nodeWritten)).toBe(typeof Bun !== 'undefined')
  })
})

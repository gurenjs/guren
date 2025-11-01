import { describe, expect, it } from 'bun:test'
import { ScryptHasher } from '../../src/auth/password/ScryptHasher'

describe('ScryptHasher', () => {
  it('hashes and verifies using Bun password helpers', async () => {
    const hasher = new ScryptHasher()

    const password = 'super-secret'
    const hashed = await hasher.hash(password)

    expect(hashed).not.toBe(password)
    expect(await hasher.verify(hashed, password)).toBe(true)
    expect(await hasher.verify(hashed, 'different')).toBe(false)
  })

  it('detects Argon2 parameter mismatches through needsRehash', async () => {
    const strictHasher = new ScryptHasher({
      algorithm: 'argon2id',
      memoryCost: 1024,
      timeCost: 2,
    })

    const hashed = await strictHasher.hash('another-secret')

    expect(strictHasher.needsRehash(hashed)).toBe(false)

    const relaxedHasher = new ScryptHasher({
      algorithm: 'argon2id',
      memoryCost: 256,
      timeCost: 1,
    })

    expect(relaxedHasher.needsRehash(hashed)).toBe(true)
  })

  it('detects bcrypt cost mismatches through needsRehash', async () => {
    const cost10Hasher = new ScryptHasher({ algorithm: 'bcrypt', cost: 10 })
    const hashed = await cost10Hasher.hash('bcrypt-pass')

    expect(cost10Hasher.needsRehash(hashed)).toBe(false)

    const cost12Hasher = new ScryptHasher({ algorithm: 'bcrypt', cost: 12 })

    expect(cost12Hasher.needsRehash(hashed)).toBe(true)
  })
})


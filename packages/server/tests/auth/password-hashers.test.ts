import { describe, test, expect } from 'bun:test'
import { ScryptHasher } from '../../src/auth/password/ScryptHasher'
import { NodeHasher } from '../../src/auth/password/NodeHasher'

describe('ScryptHasher', () => {
  const hasher = new ScryptHasher()

  test('should hash a password', async () => {
    const hashed = await hasher.hash('password123')
    expect(hashed).toBeDefined()
    expect(hashed).not.toBe('password123')
  })

  test('should verify a correct password', async () => {
    const hashed = await hasher.hash('password123')
    expect(await hasher.verify(hashed, 'password123')).toBe(true)
  })

  test('should reject an incorrect password', async () => {
    const hashed = await hasher.hash('password123')
    expect(await hasher.verify(hashed, 'wrong')).toBe(false)
  })

  test('should produce different hashes for the same password', async () => {
    const a = await hasher.hash('same')
    const b = await hasher.hash('same')
    expect(a).not.toBe(b)
  })

  describe('needsRehash', () => {
    test('should not need rehash for same algorithm defaults', async () => {
      const hashed = await hasher.hash('test')
      expect(hasher.needsRehash(hashed)).toBe(false)
    })

    test('should need rehash for different algorithm', async () => {
      const bcryptHasher = new ScryptHasher({ algorithm: 'bcrypt' })
      const argon2Hash = await hasher.hash('test')
      expect(bcryptHasher.needsRehash(argon2Hash)).toBe(true)
    })

    test('should need rehash when memory cost differs', async () => {
      const customHasher = new ScryptHasher({ memoryCost: 99999 })
      const hashed = await hasher.hash('test')
      expect(customHasher.needsRehash(hashed)).toBe(true)
    })

    test('should need rehash when time cost differs', async () => {
      const customHasher = new ScryptHasher({ timeCost: 99 })
      const hashed = await hasher.hash('test')
      expect(customHasher.needsRehash(hashed)).toBe(true)
    })
  })

  describe('bcrypt algorithm', () => {
    const bcryptHasher = new ScryptHasher({ algorithm: 'bcrypt' })

    test('should hash and verify with bcrypt', async () => {
      const hashed = await bcryptHasher.hash('password')
      expect(hashed).toContain('$2')
      expect(await bcryptHasher.verify(hashed, 'password')).toBe(true)
      expect(await bcryptHasher.verify(hashed, 'wrong')).toBe(false)
    })

    test('should detect bcrypt cost mismatch', async () => {
      const costHasher = new ScryptHasher({ algorithm: 'bcrypt', cost: 12 })
      const hashed = await new ScryptHasher({ algorithm: 'bcrypt', cost: 10 }).hash('test')
      expect(costHasher.needsRehash(hashed)).toBe(true)
    })
  })
})

describe('NodeHasher', () => {
  const hasher = new NodeHasher()

  test('should hash a password', async () => {
    const hashed = await hasher.hash('password123')
    expect(hashed).toBeDefined()
    expect(hashed).not.toBe('password123')
  })

  test('should verify a correct password', async () => {
    const hashed = await hasher.hash('password123')
    expect(await hasher.verify(hashed, 'password123')).toBe(true)
  })

  test('should reject an incorrect password', async () => {
    const hashed = await hasher.hash('password123')
    expect(await hasher.verify(hashed, 'wrong')).toBe(false)
  })

  test('should produce different hashes for the same password', async () => {
    const a = await hasher.hash('same')
    const b = await hasher.hash('same')
    expect(a).not.toBe(b)
  })

  test('should work with custom options', async () => {
    const customHasher = new NodeHasher({ cost: 8192, saltLength: 32 })
    const hashed = await customHasher.hash('test')
    expect(await customHasher.verify(hashed, 'test')).toBe(true)
  })
})

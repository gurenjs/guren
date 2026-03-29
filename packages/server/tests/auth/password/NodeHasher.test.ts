import { describe, test, expect } from 'bun:test'

import { NodeHasher } from '../../../src/auth/password/NodeHasher'

describe('NodeHasher', () => {
  const hasher = new NodeHasher()

  test('should hash a password', async () => {
    const hashed = await hasher.hash('password123')

    expect(hashed).toStartWith('$scrypt$')
    expect(hashed).toContain('N=')
    expect(hashed).toContain(',r=')
  })

  test('should verify a correct password', async () => {
    const hashed = await hasher.hash('correct-password')

    const result = await hasher.verify(hashed, 'correct-password')

    expect(result).toBe(true)
  })

  test('should reject an incorrect password', async () => {
    const hashed = await hasher.hash('correct-password')

    const result = await hasher.verify(hashed, 'wrong-password')

    expect(result).toBe(false)
  })

  test('should not need rehash with default options', async () => {
    const hashed = await hasher.hash('test')

    expect(hasher.needsRehash(hashed)).toBe(false)
  })

  test('should need rehash when cost changes', async () => {
    const hashed = await hasher.hash('test')
    const newHasher = new NodeHasher({ cost: 32768 })

    expect(newHasher.needsRehash(hashed)).toBe(true)
  })

  test('should need rehash for non-scrypt hashes', () => {
    expect(hasher.needsRehash('$argon2id$some-hash')).toBe(true)
  })

  test('should respect custom options', async () => {
    const customHasher = new NodeHasher({ cost: 8192, memory: 4 })
    const hashed = await customHasher.hash('test')

    expect(hashed).toContain('N=8192')
    expect(hashed).toContain('r=4')
  })
})

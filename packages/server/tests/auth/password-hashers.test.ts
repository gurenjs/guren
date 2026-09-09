import { afterEach, describe, test, expect } from 'bun:test'
import { ScryptHasher } from '../../src/auth/password/ScryptHasher'
import { NodeHasher } from '../../src/auth/password/NodeHasher'
import { DefaultHasher } from '../../src/auth/password/DefaultHasher'

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

describe('DefaultHasher under GUREN_TESTING', () => {
  const hasher = new DefaultHasher()
  const saved = process.env.GUREN_TESTING

  afterEach(() => {
    if (saved === undefined) delete process.env.GUREN_TESTING
    else process.env.GUREN_TESTING = saved
  })

  function argon2Params(hashed: string): Record<string, string> {
    const [, algorithm, , parameters] = hashed.split('$')
    expect(algorithm).toBe('argon2id')
    return Object.fromEntries(parameters.split(',').map((pair) => pair.split('=')))
  }

  test('hashes with the cheap parameters while the variable is set, and verifies them', async () => {
    process.env.GUREN_TESTING = '1'
    const hashed = await hasher.hash('correct horse battery')

    expect(argon2Params(hashed)).toMatchObject({ m: '1024', t: '1' })
    expect(await hasher.verify(hashed, 'correct horse battery')).toBe(true)
    expect(await hasher.verify(hashed, 'wrong')).toBe(false)
  })

  test('hashes with the production parameters when the variable is absent', async () => {
    delete process.env.GUREN_TESTING
    const hashed = await hasher.hash('correct horse battery')

    // Bun.password's Argon2id defaults; the exact numbers are Bun's to choose,
    // the cheap ones are not among them.
    const params = argon2Params(hashed)
    expect(Number(params.m)).toBeGreaterThan(1024)
    expect(Number(params.t)).toBeGreaterThan(1)
  })

  test('reads the variable per call, so a hasher built before TestApp set it still hashes cheaply', async () => {
    delete process.env.GUREN_TESTING
    const builtEarly = new DefaultHasher()
    process.env.GUREN_TESTING = '1'

    expect(argon2Params(await builtEarly.hash('x'))).toMatchObject({ m: '1024', t: '1' })
  })

  test('a hash written at the testing cost needs a rehash outside tests, and not inside them', async () => {
    process.env.GUREN_TESTING = '1'
    const cheap = await hasher.hash('correct horse battery')
    expect(hasher.needsRehash(cheap)).toBe(false)

    delete process.env.GUREN_TESTING
    expect(hasher.needsRehash(cheap)).toBe(true)
  })

  test('a production-strength hash never needs a rehash for its cost, in tests or out', async () => {
    delete process.env.GUREN_TESTING
    const strong = await hasher.hash('correct horse battery')
    expect(hasher.needsRehash(strong)).toBe(false)

    process.env.GUREN_TESTING = '1'
    expect(hasher.needsRehash(strong)).toBe(false)
  })
})

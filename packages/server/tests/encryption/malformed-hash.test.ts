import { describe, test, expect } from 'bun:test'
import { hashPassword, verifyPassword } from '../../src/encryption/Hash'
import { NodeHasher } from '../../src/auth/password/NodeHasher'

// A `$scrypt$` string whose digest decodes to zero bytes authenticates *every* password:
// scrypt returns zero bytes for a zero-length key and timingSafeEqual() of two empty
// buffers is true. A truncated column or a non-base64 digest reaches that shape.
const MALFORMED = {
  'an empty digest': '$scrypt$N=1024,r=8,p=1$c2FsdA==$',
  'an empty salt': '$scrypt$N=1024,r=8,p=1$$c2FsdA==',
  'a digest that is not base64': '$scrypt$N=1024,r=8,p=1$c2FsdA==$!!!',
  'unparseable parameters': '$scrypt$N=x,r=y,p=z$c2FsdA==$c2FsdA==',
  'a negative cost': '$scrypt$N=-1,r=8,p=1$c2FsdA==$c2FsdA==',
  'a zero block size': '$scrypt$N=1024,r=0,p=1$c2FsdA==$c2FsdA==',
}

describe('verifyPassword rejects a malformed hash', () => {
  test.each(Object.entries(MALFORMED))('rejects %s', async (_label, hash) => {
    await expect(verifyPassword('any-password-at-all', hash)).rejects.toThrow(
      'Invalid password hash format.',
    )
    // Two different passwords agreeing is the signature of the bypass this pins shut.
    await expect(NodeHasher.prototype.verify.call(new NodeHasher(), hash, 'other')).rejects.toThrow()
  })

  test('still verifies a well-formed hash', async () => {
    const hashed = await hashPassword('password123', { cost: 1024 })

    expect(await verifyPassword('password123', hashed)).toBe(true)
    expect(await verifyPassword('wrong', hashed)).toBe(false)
  })

  test('honours the parallelism encoded in the hash', async () => {
    // p is read back from the hash, so tampering with it changes the derivation.
    const hashed = await hashPassword('password123', { cost: 1024 })
    const tampered = hashed.replace('p=1', 'p=2')

    expect(await verifyPassword('password123', tampered)).toBe(false)
  })
})

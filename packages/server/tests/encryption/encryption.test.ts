import { describe, test, expect, beforeEach } from 'bun:test'
import {
  // Encrypter
  Encrypter,
  generateKey,
  setEncrypter,
  getEncrypter,
  encrypt,
  decrypt,
  normalizeAppKey,
  parseAppKey,
  deriveAppKeyring,
  MessageSigner,
  signUrl,
  verifySignedUrl,
  // Hash
  hash,
  hmac,
  verifyHmac,
  sha256,
  sha512,
  md5,
  hashPassword,
  verifyPassword,
  needsRehash,
  secureCompare,
  check,
  // Random
  randomString,
  random,
  randomHex,
  randomBase64,
  randomBase64Url,
  uuid,
  randomInt,
  urlSafeToken,
  generatePassword,
  generateOtp,
  generateSlug,
  shuffle,
  pick,
  sample,
} from '../../src/encryption'

// ===================
// Encrypter Tests
// ===================

describe('Encrypter', () => {
  let encrypter: Encrypter
  let key: string

  beforeEach(() => {
    key = generateKey()
    encrypter = new Encrypter({ key })
  })

  describe('generateKey', () => {
    test('generates 32-byte base64 key', () => {
      const newKey = generateKey()
      expect(newKey.startsWith('base64:')).toBe(true)
      const decoded = Buffer.from(newKey.slice('base64:'.length), 'base64')
      expect(decoded.length).toBe(32)
    })

    test('generates unique keys', () => {
      const keys = new Set(Array.from({ length: 100 }, () => generateKey()))
      expect(keys.size).toBe(100)
    })

    test('normalizes APP_KEY format', () => {
      const raw = Buffer.alloc(32, 1).toString('base64')
      expect(normalizeAppKey(raw)).toBe(`base64:${raw}`)
      expect(parseAppKey(raw)).toBeInstanceOf(Buffer)
    })
  })

  describe('constructor', () => {
    test('throws on invalid key length', () => {
      expect(() => {
        new Encrypter({ key: Buffer.from('short').toString('base64') })
      }).toThrow('32-byte')
    })

    test('decrypts with previous keys during key rotation', () => {
      const oldKey = generateKey()
      const rotatedKey = generateKey()
      const oldEncrypter = new Encrypter({ key: oldKey })
      const rotatedEncrypter = new Encrypter({ key: rotatedKey, previousKeys: [oldKey] })

      const encrypted = oldEncrypter.encryptString('rotated')

      expect(rotatedEncrypter.decryptString(encrypted)).toBe('rotated')
    })
  })

  describe('encrypt/decrypt (GCM)', () => {
    test('encrypts and decrypts objects', () => {
      const data = { userId: 123, name: 'John' }
      const encrypted = encrypter.encrypt(data)
      const decrypted = encrypter.decrypt(encrypted)

      expect(decrypted).toEqual(data)
    })

    test('encrypts and decrypts strings', () => {
      const data = 'Hello, World!'
      const encrypted = encrypter.encryptString(data)
      const decrypted = encrypter.decryptString(encrypted)

      expect(decrypted).toBe(data)
    })

    test('encrypts and decrypts arrays', () => {
      const data = [1, 2, 3, 'four', { five: 5 }]
      const encrypted = encrypter.encrypt(data)
      const decrypted = encrypter.decrypt(encrypted)

      expect(decrypted).toEqual(data)
    })

    test('produces different ciphertext each time', () => {
      const data = 'same data'
      const encrypted1 = encrypter.encrypt(data)
      const encrypted2 = encrypter.encrypt(data)

      expect(encrypted1).not.toBe(encrypted2)
    })

    test('fails with wrong key', () => {
      const encrypted = encrypter.encrypt('secret')
      const wrongKey = generateKey()
      const wrongEncrypter = new Encrypter({ key: wrongKey })

      expect(() => wrongEncrypter.decrypt(encrypted)).toThrow()
    })

    test('fails with tampered data', () => {
      const encrypted = encrypter.encrypt('secret')
      // Tamper with base64
      const tampered = encrypted.slice(0, -4) + 'XXXX'

      expect(() => encrypter.decrypt(tampered)).toThrow()
    })

    // Node and Bun accept 4-byte GCM tags and `setAuthTag()` adopts whatever
    // length it is handed, so a payload rewritten with a truncated tag would
    // drop forgery resistance from 2^128 to 2^32. Nothing this class writes
    // has a short tag, so requiring the full 16 bytes rejects only rewrites.
    test('refuses a payload whose authentication tag has been truncated', () => {
      const encrypted = encrypter.encrypt('secret')
      const payload = JSON.parse(Buffer.from(encrypted, 'base64').toString('utf8'))

      expect(Buffer.from(payload.tag, 'base64').length).toBe(16)

      payload.tag = Buffer.from(payload.tag, 'base64').subarray(0, 4).toString('base64')
      const truncated = Buffer.from(JSON.stringify(payload)).toString('base64')

      expect(() => encrypter.decrypt(truncated)).toThrow('Invalid authentication tag length.')
    })
  })

  describe('encrypt/decrypt (CBC)', () => {
    test('encrypts and decrypts with CBC mode', () => {
      const cbcEncrypter = new Encrypter({ key, cipher: 'aes-256-cbc' })
      const data = { message: 'Hello CBC' }
      const encrypted = cbcEncrypter.encrypt(data)
      const decrypted = cbcEncrypter.decrypt(encrypted)

      expect(decrypted).toEqual(data)
    })
  })

  describe('global encrypter', () => {
    test('setEncrypter and getEncrypter work', () => {
      setEncrypter(encrypter)
      expect(getEncrypter()).toBe(encrypter)
    })

    test('encrypt and decrypt helpers use global encrypter', () => {
      setEncrypter(encrypter)
      const data = { test: true }
      const encrypted = encrypt(data)
      const decrypted = decrypt(encrypted)

      expect(decrypted).toEqual(data)
    })
  })

  describe('message signing', () => {
    test('signs and verifies claims', () => {
      const keyring = deriveAppKeyring({ current: parseAppKey(key), previous: [] }, 'message-signing')
      const signer = new MessageSigner(keyring)
      const signed = signer.sign({ userId: 1 }, { purpose: 'test', expiresIn: 60_000 })

      expect(signer.verify<{ userId: number }>(signed, { purpose: 'test' })?.userId).toBe(1)
      expect(signer.verify(signed, { purpose: 'other' })).toBeNull()
    })

    test('returns null for expired token', () => {
      const keyring = deriveAppKeyring({ current: parseAppKey(key), previous: [] }, 'message-signing')
      const signer = new MessageSigner(keyring)
      const signed = signer.sign({ userId: 1 }, { purpose: 'test', expiresIn: -1000 })

      expect(signer.verify(signed, { purpose: 'test' })).toBeNull()
      expect(signer.verify(signed, { purpose: 'test', allowExpired: true })?.userId).toBe(1)
    })

    test('signs and verifies URLs', () => {
      const keyring = deriveAppKeyring({ current: parseAppKey(key), previous: [] }, 'message-signing')
      const signedUrl = signUrl('https://example.com/invite?b=2&a=1', keyring, { expiresIn: 60_000 })

      expect(verifySignedUrl(signedUrl, keyring)).toBe(true)
      expect(verifySignedUrl(`${signedUrl}x`, keyring)).toBe(false)
    })
  })
})

// ===================
// Hash Tests
// ===================

describe('Hash', () => {
  describe('hash', () => {
    test('creates SHA-256 hash by default', () => {
      const result = hash('hello')
      expect(result).toHaveLength(64) // 32 bytes = 64 hex chars
    })

    test('creates consistent hashes', () => {
      const hash1 = hash('test')
      const hash2 = hash('test')
      expect(hash1).toBe(hash2)
    })

    test('different inputs produce different hashes', () => {
      const hash1 = hash('hello')
      const hash2 = hash('world')
      expect(hash1).not.toBe(hash2)
    })

    test('supports different algorithms', () => {
      const sha256Hash = hash('test', 'sha256')
      const sha512Hash = hash('test', 'sha512')
      const md5Hash = hash('test', 'md5')

      expect(sha256Hash).toHaveLength(64)
      expect(sha512Hash).toHaveLength(128)
      expect(md5Hash).toHaveLength(32)
    })

    test('supports different encodings', () => {
      const hexHash = hash('test', 'sha256', 'hex')
      const base64Hash = hash('test', 'sha256', 'base64')

      expect(hexHash).not.toBe(base64Hash)
    })
  })

  describe('sha256/sha512/md5 shortcuts', () => {
    test('sha256 creates correct hash', () => {
      const result = sha256('hello')
      expect(result).toBe(hash('hello', 'sha256'))
    })

    test('sha512 creates correct hash', () => {
      const result = sha512('hello')
      expect(result).toBe(hash('hello', 'sha512'))
    })

    test('md5 creates correct hash', () => {
      const result = md5('hello')
      expect(result).toBe(hash('hello', 'md5'))
    })
  })

  describe('hmac', () => {
    test('creates HMAC signature', () => {
      const signature = hmac('message', 'secret-key')
      expect(signature).toHaveLength(64)
    })

    test('same message and key produce same signature', () => {
      const sig1 = hmac('message', 'key')
      const sig2 = hmac('message', 'key')
      expect(sig1).toBe(sig2)
    })

    test('different keys produce different signatures', () => {
      const sig1 = hmac('message', 'key1')
      const sig2 = hmac('message', 'key2')
      expect(sig1).not.toBe(sig2)
    })
  })

  describe('verifyHmac', () => {
    test('verifies valid signature', () => {
      const signature = hmac('message', 'key')
      expect(verifyHmac('message', signature, 'key')).toBe(true)
    })

    test('rejects invalid signature', () => {
      const signature = hmac('message', 'key')
      expect(verifyHmac('different', signature, 'key')).toBe(false)
    })
  })

  describe('check', () => {
    test('verifies hash matches', () => {
      const hashed = sha256('password')
      expect(check('password', hashed)).toBe(true)
      expect(check('wrong', hashed)).toBe(false)
    })
  })

  describe('secureCompare', () => {
    test('returns true for equal strings', () => {
      expect(secureCompare('hello', 'hello')).toBe(true)
    })

    test('returns false for different strings', () => {
      expect(secureCompare('hello', 'world')).toBe(false)
    })

    test('returns false for different lengths', () => {
      expect(secureCompare('short', 'longer string')).toBe(false)
    })
  })
})

// ===================
// Password Hash Tests
// ===================

describe('Password Hashing', () => {
  describe('hashPassword', () => {
    test('creates password hash', async () => {
      const hashed = await hashPassword('mypassword')
      expect(hashed).toContain('$scrypt$')
    })

    test('produces different hashes for same password', async () => {
      const hash1 = await hashPassword('password')
      const hash2 = await hashPassword('password')
      expect(hash1).not.toBe(hash2)
    })
  })

  describe('verifyPassword', () => {
    test('verifies correct password', async () => {
      const hashed = await hashPassword('correct')
      expect(await verifyPassword('correct', hashed)).toBe(true)
    })

    test('rejects wrong password', async () => {
      const hashed = await hashPassword('correct')
      expect(await verifyPassword('wrong', hashed)).toBe(false)
    })

    test('throws on invalid hash format', async () => {
      await expect(verifyPassword('test', 'invalid')).rejects.toThrow('Invalid')
    })
  })

  describe('needsRehash', () => {
    test('returns false for matching parameters', async () => {
      const hashed = await hashPassword('password', { cost: 16384, memory: 8 })
      expect(needsRehash(hashed, { cost: 16384, memory: 8 })).toBe(false)
    })

    test('returns true for different parameters', async () => {
      const hashed = await hashPassword('password', { cost: 16384, memory: 8 })
      expect(needsRehash(hashed, { cost: 32768, memory: 8 })).toBe(true)
    })

    test('returns true for invalid hash', () => {
      expect(needsRehash('invalid')).toBe(true)
    })
  })
})

// ===================
// Random Tests
// ===================

describe('Random', () => {
  describe('randomString', () => {
    test('generates string of correct length', () => {
      expect(randomString(16)).toHaveLength(16)
      expect(randomString(32)).toHaveLength(32)
    })

    test('generates alphanumeric by default', () => {
      const str = randomString(100)
      expect(str).toMatch(/^[A-Za-z0-9]+$/)
    })

    test('supports different charsets', () => {
      const hex = randomString(16, { charset: 'hex' })
      expect(hex).toMatch(/^[0-9a-f]+$/)

      const numeric = randomString(16, { charset: 'numeric' })
      expect(numeric).toMatch(/^[0-9]+$/)

      const alphabetic = randomString(16, { charset: 'alphabetic' })
      expect(alphabetic).toMatch(/^[A-Za-z]+$/)
    })

    test('generates unique strings', () => {
      const strings = new Set(Array.from({ length: 100 }, () => randomString(16)))
      expect(strings.size).toBe(100)
    })
  })

  describe('random/randomHex/randomBase64', () => {
    test('random generates bytes', () => {
      const bytes = random(32)
      expect(bytes).toBeInstanceOf(Buffer)
      expect(bytes.length).toBe(32)
    })

    test('randomHex generates hex string', () => {
      const hex = randomHex(16)
      expect(hex).toHaveLength(32) // 16 bytes = 32 hex chars
      expect(hex).toMatch(/^[0-9a-f]+$/)
    })

    test('randomBase64 generates base64 string', () => {
      const b64 = randomBase64(16)
      expect(Buffer.from(b64, 'base64')).toHaveLength(16)
    })

    test('randomBase64Url generates URL-safe string', () => {
      const b64url = randomBase64Url(32)
      expect(b64url).not.toContain('+')
      expect(b64url).not.toContain('/')
      expect(b64url).not.toContain('=')
    })
  })

  describe('uuid', () => {
    test('generates valid UUID v4', () => {
      const id = uuid()
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    })

    test('generates unique UUIDs', () => {
      const uuids = new Set(Array.from({ length: 100 }, () => uuid()))
      expect(uuids.size).toBe(100)
    })
  })

  describe('randomInt', () => {
    test('generates integers in range', () => {
      for (let i = 0; i < 100; i++) {
        const n = randomInt(1, 10)
        expect(n).toBeGreaterThanOrEqual(1)
        expect(n).toBeLessThanOrEqual(10)
      }
    })
  })

  describe('urlSafeToken', () => {
    test('generates URL-safe token', () => {
      const token = urlSafeToken(32)
      expect(token).toHaveLength(32)
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    })
  })

  describe('generatePassword', () => {
    test('generates password of correct length', () => {
      expect(generatePassword(16)).toHaveLength(16)
    })

    test('includes all character types by default', () => {
      // Generate many passwords to ensure coverage
      const passwords = Array.from({ length: 50 }, () => generatePassword(32))
      const combined = passwords.join('')

      expect(combined).toMatch(/[A-Z]/)
      expect(combined).toMatch(/[a-z]/)
      expect(combined).toMatch(/[0-9]/)
      expect(combined).toMatch(/[!@#$%^&*()\-_=+[\]{}|;:,.<>?]/)
    })
  })

  describe('generateOtp', () => {
    test('generates numeric OTP', () => {
      const otp = generateOtp(6)
      expect(otp).toHaveLength(6)
      expect(otp).toMatch(/^[0-9]+$/)
    })
  })

  describe('generateSlug', () => {
    test('generates hex slug', () => {
      const slug = generateSlug(10)
      expect(slug).toHaveLength(10)
      expect(slug).toMatch(/^[0-9a-f]+$/)
    })
  })

  describe('shuffle', () => {
    test('shuffles array', () => {
      const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      const shuffled = shuffle(original)

      expect(shuffled).toHaveLength(original.length)
      expect(shuffled.sort()).toEqual(original.sort())
    })

    test('does not modify original array', () => {
      const original = [1, 2, 3]
      shuffle(original)
      expect(original).toEqual([1, 2, 3])
    })
  })

  describe('pick', () => {
    test('picks element from array', () => {
      const array = ['a', 'b', 'c']
      const picked = pick(array)
      expect(array).toContain(picked)
    })

    test('throws on empty array', () => {
      expect(() => pick([])).toThrow('empty array')
    })
  })

  describe('sample', () => {
    test('samples multiple elements', () => {
      const array = [1, 2, 3, 4, 5]
      const sampled = sample(array, 3)

      expect(sampled).toHaveLength(3)
      for (const item of sampled) {
        expect(array).toContain(item)
      }
    })

    test('throws if count exceeds length', () => {
      expect(() => sample([1, 2], 5)).toThrow('exceeds')
    })
  })
})

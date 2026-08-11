import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'crypto'
import type { EncrypterConfig, EncryptOptions, DecryptOptions, EncryptedPayload } from './types'
import { generateAppKey, normalizeAppKey } from './app-key'

/**
 * GCM authentication tag length, in bytes.
 *
 * Pinned on both sides. Node and Bun accept 4-, 8-, 12-, 13-, 14-, 15- and
 * 16-byte GCM tags, and `setAuthTag()` adopts whatever length it is handed — so
 * a payload rewritten with a 4-byte tag would be accepted, dropping forgery
 * resistance from 2^128 to 2^32. Everything this class writes uses the full
 * tag, so nothing legitimate is rejected by requiring it.
 */
const GCM_TAG_BYTES = 16

/**
 * Encrypter for secure data encryption using AES.
 *
 * @example
 * ```typescript
 * const encrypter = new Encrypter({ key: 'base64-encoded-32-byte-key' })
 *
 * // Encrypt
 * const encrypted = encrypter.encrypt({ userId: 123, role: 'admin' })
 *
 * // Decrypt
 * const data = encrypter.decrypt(encrypted)
 * ```
 */
export class Encrypter {
  /**
   * Encryption key.
   */
  protected key: Buffer
  protected previousKeys: Buffer[]

  /**
   * Cipher algorithm.
   */
  protected cipher: 'aes-256-gcm' | 'aes-256-cbc'

  constructor(config: EncrypterConfig) {
    this.key = Buffer.from(normalizeAppKey(config.key).slice('base64:'.length), 'base64')
    this.previousKeys = (config.previousKeys ?? []).map((key) =>
      Buffer.from(normalizeAppKey(key).slice('base64:'.length), 'base64'),
    )
    this.cipher = config.cipher ?? 'aes-256-gcm'
  }

  /**
   * Encrypt a value.
   */
  encrypt(value: unknown, options: EncryptOptions = {}): string {
    const serialize = options.serialize !== false
    const data = serialize ? JSON.stringify(value) : String(value)

    if (this.cipher === 'aes-256-gcm') {
      return this.encryptGcm(data)
    }

    return this.encryptCbc(data)
  }

  /**
   * Decrypt a value.
   */
  decrypt<T = unknown>(payload: string, options: DecryptOptions = {}): T {
    const deserialize = options.deserialize !== false

    let parsed: EncryptedPayload
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    } catch {
      throw new Error('Invalid encrypted payload.')
    }

    let decrypted: string
    if (parsed.tag) {
      decrypted = this.decryptGcm(parsed)
    } else if (parsed.mac) {
      decrypted = this.decryptCbc(parsed)
    } else {
      throw new Error('Invalid encrypted payload format.')
    }

    if (deserialize) {
      try {
        return JSON.parse(decrypted) as T
      } catch {
        return decrypted as T
      }
    }

    return decrypted as T
  }

  /**
   * Encrypt a string (no serialization).
   */
  encryptString(value: string): string {
    return this.encrypt(value, { serialize: false })
  }

  /**
   * Decrypt a string (no deserialization).
   */
  decryptString(payload: string): string {
    return this.decrypt(payload, { deserialize: false })
  }

  /**
   * Encrypt using AES-256-GCM.
   */
  protected encryptGcm(data: string): string {
    const iv = randomBytes(12) // 96 bits for GCM
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: GCM_TAG_BYTES })

    const encrypted = Buffer.concat([
      cipher.update(data, 'utf8'),
      cipher.final(),
    ])

    const tag = cipher.getAuthTag()

    const payload: EncryptedPayload = {
      iv: iv.toString('base64'),
      value: encrypted.toString('base64'),
      tag: tag.toString('base64'),
    }

    return Buffer.from(JSON.stringify(payload)).toString('base64')
  }

  /**
   * Decrypt using AES-256-GCM.
   */
  protected decryptGcm(payload: EncryptedPayload): string {
    // Decoded once, outside the key loop: all three are properties of the
    // payload, not of the key being tried. The tag's length check belongs here
    // for the same reason — retrying a short tag per key would only hide why
    // it failed.
    const iv = Buffer.from(payload.iv, 'base64')
    const encrypted = Buffer.from(payload.value, 'base64')
    const tag = Buffer.from(payload.tag!, 'base64')
    if (tag.length !== GCM_TAG_BYTES) {
      throw new Error('Invalid authentication tag length.')
    }

    return this.tryDecryptWithKeys((key) => {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES })
      decipher.setAuthTag(tag)

      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ])

      return decrypted.toString('utf8')
    })
  }

  /**
   * Encrypt using AES-256-CBC with HMAC.
   */
  protected encryptCbc(data: string): string {
    const iv = randomBytes(16) // 128 bits for CBC
    const cipher = createCipheriv('aes-256-cbc', this.key, iv)

    const encrypted = Buffer.concat([
      cipher.update(data, 'utf8'),
      cipher.final(),
    ])

    const mac = this.createMac(iv, encrypted)

    const payload: EncryptedPayload = {
      iv: iv.toString('base64'),
      value: encrypted.toString('base64'),
      mac,
    }

    return Buffer.from(JSON.stringify(payload)).toString('base64')
  }

  /**
   * Decrypt using AES-256-CBC with HMAC verification.
   */
  protected decryptCbc(payload: EncryptedPayload): string {
    return this.tryDecryptWithKeys((key) => {
      const iv = Buffer.from(payload.iv, 'base64')
      const encrypted = Buffer.from(payload.value, 'base64')

      const expectedMac = this.createMac(iv, encrypted, key)
      if (!this.secureCompare(payload.mac!, expectedMac)) {
        throw new Error('MAC verification failed.')
      }

      const decipher = createDecipheriv('aes-256-cbc', key, iv)
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ])

      return decrypted.toString('utf8')
    })
  }

  /**
   * Create HMAC for CBC mode.
   */
  protected createMac(iv: Buffer, encrypted: Buffer, key: Buffer = this.key): string {
    const hmac = createHmac('sha256', key)
    hmac.update(iv)
    hmac.update(encrypted)
    return hmac.digest('hex')
  }

  /**
   * Constant-time string comparison.
   */
  protected secureCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false
    }

    let result = 0
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i)
    }

    return result === 0
  }

  /**
   * Get the encryption key (base64).
   */
  getKey(): string {
    return this.key.toString('base64')
  }

  protected tryDecryptWithKeys(run: (key: Buffer) => string): string {
    const keys = [this.key, ...this.previousKeys]
    let lastError: Error | undefined

    for (const key of keys) {
      try {
        return run(key)
      } catch (error) {
        lastError = error as Error
      }
    }

    throw lastError ?? new Error('Failed to decrypt payload.')
  }
}

/**
 * Generate a random encryption key.
 */
export function generateKey(): string {
  return generateAppKey()
}

// Global encrypter instance
let globalEncrypter: Encrypter | null = null

/**
 * Create an encrypter instance.
 */
export function createEncrypter(config: EncrypterConfig): Encrypter {
  return new Encrypter(config)
}

/**
 * Set the global encrypter.
 */
export function setEncrypter(encrypter: Encrypter): void {
  globalEncrypter = encrypter
}

/**
 * Get the global encrypter.
 */
export function getEncrypter(): Encrypter {
  if (!globalEncrypter) {
    throw new Error('Encrypter not initialized. Call setEncrypter() first.')
  }
  return globalEncrypter
}

/**
 * Encrypt a value using the global encrypter.
 */
export function encrypt(value: unknown, options?: EncryptOptions): string {
  return getEncrypter().encrypt(value, options)
}

/**
 * Decrypt a value using the global encrypter.
 */
export function decrypt<T = unknown>(payload: string, options?: DecryptOptions): T {
  return getEncrypter().decrypt<T>(payload, options)
}

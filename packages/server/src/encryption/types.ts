/**
 * Encryption options.
 */
export interface EncryptOptions {
  /**
   * Whether to serialize the value before encryption.
   */
  serialize?: boolean
}

/**
 * Decryption options.
 */
export interface DecryptOptions {
  /**
   * Whether to deserialize the value after decryption.
   */
  deserialize?: boolean
}

/**
 * Encrypter configuration.
 */
export interface EncrypterConfig {
  /**
   * Encryption key (base64 encoded, 32 bytes for AES-256).
   */
  key: string

  /**
   * Encryption cipher to use.
   */
  cipher?: 'aes-256-gcm' | 'aes-256-cbc'
}

/**
 * Encrypted payload structure.
 */
export interface EncryptedPayload {
  /**
   * Initialization vector (base64).
   */
  iv: string

  /**
   * Encrypted value (base64).
   */
  value: string

  /**
   * Authentication tag for GCM mode (base64).
   */
  tag?: string

  /**
   * MAC for CBC mode (hex).
   */
  mac?: string
}

/**
 * Hash algorithm options.
 */
export type HashAlgorithm = 'sha256' | 'sha384' | 'sha512' | 'md5' | 'sha1'

/**
 * HMAC options.
 */
export interface HmacOptions {
  /**
   * Hash algorithm to use.
   */
  algorithm?: HashAlgorithm

  /**
   * Output encoding.
   */
  encoding?: 'hex' | 'base64'
}

/**
 * Password hash options.
 */
export interface PasswordHashOptions {
  /**
   * Memory cost (for scrypt/argon2).
   */
  memory?: number

  /**
   * CPU cost (for scrypt/argon2).
   */
  cost?: number

  /**
   * Salt length in bytes.
   */
  saltLength?: number

  /**
   * Key length in bytes.
   */
  keyLength?: number
}

/**
 * Random string options.
 */
export interface RandomStringOptions {
  /**
   * Character set to use.
   */
  charset?: 'alphanumeric' | 'alphabetic' | 'numeric' | 'hex' | 'base64' | 'url-safe'
}

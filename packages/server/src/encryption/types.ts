export interface EncryptOptions {
  serialize?: boolean
}

export interface DecryptOptions {
  deserialize?: boolean
}

export interface EncrypterConfig {
  /** Base64; 32 bytes for AES-256. */
  key: string

  /** Decryption-only fallbacks, for key rotation. */
  previousKeys?: string[]

  cipher?: 'aes-256-gcm' | 'aes-256-cbc'
}

export interface EncryptedPayload {
  /** Base64. */
  iv: string

  /** Base64. */
  value: string

  /** GCM authentication tag, base64. */
  tag?: string

  /** CBC MAC, hex. */
  mac?: string
}

export type HashAlgorithm = 'sha256' | 'sha384' | 'sha512' | 'md5' | 'sha1'

export interface HmacOptions {
  algorithm?: HashAlgorithm

  encoding?: 'hex' | 'base64'
}

export interface PasswordHashOptions {
  /** For scrypt/argon2. */
  memory?: number

  /** For scrypt/argon2. */
  cost?: number

  /** Bytes. */
  saltLength?: number

  /** Bytes. */
  keyLength?: number
}

export interface RandomStringOptions {
  charset?: 'alphanumeric' | 'alphabetic' | 'numeric' | 'hex' | 'base64' | 'url-safe'
}

import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'crypto'
import { promisify } from 'util'
import type { HashAlgorithm, HmacOptions, PasswordHashOptions } from './types'

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: ScryptOptions
) => Promise<Buffer>

/** Hash a value; SHA-256 by default. */
export function hash(
  value: string | Buffer,
  algorithm: HashAlgorithm = 'sha256',
  encoding: 'hex' | 'base64' = 'hex'
): string {
  return createHash(algorithm).update(value).digest(encoding)
}

/** Create an HMAC signature; SHA-256 by default. */
export function hmac(
  value: string | Buffer,
  key: string | Buffer,
  options: HmacOptions = {}
): string {
  const { algorithm = 'sha256', encoding = 'hex' } = options
  return createHmac(algorithm, key).update(value).digest(encoding)
}

export function verifyHmac(
  value: string | Buffer,
  signature: string,
  key: string | Buffer,
  options: HmacOptions = {}
): boolean {
  const expected = hmac(value, key, options)
  return secureCompare(signature, expected)
}

export function sha256(value: string | Buffer): string {
  return hash(value, 'sha256')
}

export function sha512(value: string | Buffer): string {
  return hash(value, 'sha512')
}

/** Not secure — checksums only. */
export function md5(value: string | Buffer): string {
  return hash(value, 'md5')
}

/** scrypt, returning `$scrypt$N=16384,r=8,p=1$salt$hash`. */
export async function hashPassword(
  password: string,
  options: PasswordHashOptions = {}
): Promise<string> {
  const {
    cost = 16384, // N
    memory = 8,   // r (block size)
    saltLength = 16,
    keyLength = 64,
  } = options

  const salt = randomBytes(saltLength)
  const derived = await scryptAsync(password, salt, keyLength, {
    N: cost,
    r: memory,
    p: 1,
  })

  const params = `N=${cost},r=${memory},p=1`
  return `$scrypt$${params}$${salt.toString('base64')}$${derived.toString('base64')}`
}

/** Verify a password against a hash. */
export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  if (!hash.startsWith('$scrypt$')) {
    throw new Error('Invalid password hash format.')
  }

  const parts = hash.split('$')
  if (parts.length !== 5) {
    throw new Error('Invalid password hash format.')
  }

  const [, , paramsStr, saltB64, hashB64] = parts

  const params: Record<string, number> = {}
  for (const param of paramsStr.split(',')) {
    const [key, value] = param.split('=')
    params[key] = parseInt(value, 10)
  }

  const salt = Buffer.from(saltB64, 'base64')
  const expectedHash = Buffer.from(hashB64, 'base64')

  // A hash whose digest decodes to nothing authenticates *every* password:
  // scrypt asked for a zero-length key returns zero bytes, and timingSafeEqual()
  // of two empty buffers is true — hence the guard on decoded lengths rather
  // than on the string. Likewise parseInt() yields NaN for a corrupt parameter,
  // which scrypt would otherwise coerce into defaults of its own.
  if (salt.length === 0 || expectedHash.length === 0) {
    throw new Error('Invalid password hash format.')
  }
  if (!isPositiveInteger(params.N) || !isPositiveInteger(params.r) || !isPositiveInteger(params.p ?? 1)) {
    throw new Error('Invalid password hash format.')
  }

  const derived = await scryptAsync(password, salt, expectedHash.length, {
    N: params.N,
    r: params.r,
    p: params.p ?? 1,
  })

  return timingSafeEqual(derived, expectedHash)
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** Whether the hash was made with different parameters than `options`. */
export function needsRehash(
  hash: string,
  options: PasswordHashOptions = {}
): boolean {
  const { cost = 16384, memory = 8 } = options

  if (!hash.startsWith('$scrypt$')) {
    return true
  }

  const parts = hash.split('$')
  if (parts.length !== 5) {
    return true
  }

  const paramsStr = parts[2]
  const params: Record<string, number> = {}
  for (const param of paramsStr.split(',')) {
    const [key, value] = param.split('=')
    params[key] = parseInt(value, 10)
  }

  return params.N !== cost || params.r !== memory
}

/** Constant-time comparison. */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }

  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)

  return timingSafeEqual(bufA, bufB)
}

export function check(
  value: string | Buffer,
  hash: string,
  algorithm: HashAlgorithm = 'sha256'
): boolean {
  const computed = createHash(algorithm).update(value).digest('hex')
  return secureCompare(computed, hash)
}

import { hkdfSync, randomBytes } from 'node:crypto'

const APP_KEY_PREFIX = 'base64:'
const APP_KEY_BYTES = 32

export interface AppKeyring {
  current: Buffer
  previous: Buffer[]
}

function decodeAppKey(rawKey: string, envName: string): Buffer {
  const trimmed = rawKey.trim()
  if (!trimmed) {
    throw new Error(`${envName} is required and must be a base64-encoded 32-byte key.`)
  }

  const encoded = trimmed.startsWith(APP_KEY_PREFIX)
    ? trimmed.slice(APP_KEY_PREFIX.length)
    : trimmed
  const decoded = Buffer.from(encoded, 'base64')

  if (decoded.length !== APP_KEY_BYTES || decoded.toString('base64') !== encoded.replace(/\s+/gu, '')) {
    throw new Error(`${envName} must be a base64-encoded 32-byte key.`)
  }

  return decoded
}

export function normalizeAppKey(rawKey: string, envName = 'APP_KEY'): string {
  return `${APP_KEY_PREFIX}${decodeAppKey(rawKey, envName).toString('base64')}`
}

export function parseAppKey(rawKey: string, envName = 'APP_KEY'): Buffer {
  return decodeAppKey(rawKey, envName)
}

export function parsePreviousAppKeys(rawKeys: string | undefined, envName = 'APP_PREVIOUS_KEYS'): Buffer[] {
  if (!rawKeys) {
    return []
  }

  return rawKeys
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value, index) => decodeAppKey(value, `${envName}[${index}]`))
}

export function getAppKeyringFromEnv(env = process.env): AppKeyring {
  return {
    current: parseAppKey(env.APP_KEY ?? '', 'APP_KEY'),
    previous: parsePreviousAppKeys(env.APP_PREVIOUS_KEYS),
  }
}

export function deriveAppKey(rootKey: Buffer, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', rootKey, Buffer.alloc(0), Buffer.from(`guren:${purpose}`, 'utf8'), APP_KEY_BYTES),
  )
}

export function deriveAppKeyring(keyring: AppKeyring, purpose: string): AppKeyring {
  return {
    current: deriveAppKey(keyring.current, purpose),
    previous: keyring.previous.map((key) => deriveAppKey(key, purpose)),
  }
}

export function encodeDerivedKey(key: Buffer): string {
  return `${APP_KEY_PREFIX}${key.toString('base64')}`
}

export function generateAppKey(): string {
  return `${APP_KEY_PREFIX}${randomBytes(APP_KEY_BYTES).toString('base64')}`
}

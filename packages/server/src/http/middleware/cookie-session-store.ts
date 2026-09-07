import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { deriveAppKeyring, getAppKeyringFromEnv, type AppKeyring } from '../../encryption/app-key'
import type { SessionData, SessionStore } from './session'

const IV_BYTES = 12
const TAG_BYTES = 16

export interface CookieSessionStoreOptions {
  /** Clock for expiry, injectable for tests. @default Date.now */
  now?: () => number
  /** Overrides the keyring derived from `APP_KEY` / `APP_PREVIOUS_KEYS`; for tests and direct construction. */
  keyring?: AppKeyring
}

interface CookiePayload {
  id: string
  data: SessionData
  /** Unix ms. Nothing server-side can expire a cookie early, so this is what makes the TTL real. */
  expiresAt: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The whole session, encrypted inside the cookie under the app key: the one
 * store needing no server-side resource (RFC 0020 §3). Two limits the docs
 * state outright — everything in the session travels in the cookie, so the
 * middleware caps it; and a logout cannot revoke a copy the client already
 * has, so anything revocable belongs in the database with only its id here.
 */
export class CookieSessionStore implements SessionStore {
  private readonly keyring: AppKeyring
  private readonly now: () => number

  constructor(options: CookieSessionStoreOptions = {}) {
    this.keyring = options.keyring ?? deriveAppKeyring(getAppKeyringFromEnv(), 'cookie-session')
    this.now = options.now ?? (() => Date.now())
  }

  readonly inline = {
    /**
     * `base64url(iv ‖ tag ‖ ciphertext)` rather than `Encrypter`'s envelope,
     * which base64s the ciphertext into JSON and base64s that again: measured
     * 2.27x the plaintext against 1.52x here, and a cookie's budget is this
     * store's whole constraint. Same primitives, same 12-byte IV and 16-byte tag.
     */
    encode: (id: string, data: SessionData, ttlSeconds: number): string => {
      const payload: CookiePayload = { id, data, expiresAt: this.now() + ttlSeconds * 1000 }
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', this.keyring.current, iv, { authTagLength: TAG_BYTES })
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
    },

    decode: (cookieValue: string | undefined): { id: string; data: SessionData } | null => {
      if (!cookieValue) return null

      const raw = Buffer.from(cookieValue, 'base64url')
      if (raw.length <= IV_BYTES + TAG_BYTES) return null

      const iv = raw.subarray(0, IV_BYTES)
      const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
      const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES)

      // Previous keys are tried too, so rotating APP_KEY does not log everyone out.
      for (const key of [this.keyring.current, ...this.keyring.previous]) {
        const payload = this.open(key, iv, tag, ciphertext)
        if (payload) return payload
      }
      return null
    },
  }

  private open(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer): { id: string; data: SessionData } | null {
    let plaintext: string
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
      decipher.setAuthTag(tag)
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch {
      // A tampered payload, or one encrypted under a key outside the ring.
      return null
    }

    let payload: unknown
    try {
      payload = JSON.parse(plaintext)
    } catch {
      return null
    }

    // Shape-checked rather than trusted: a payload written by another version of
    // the app is authentic but need not be readable, and a half-read session is
    // worse than a fresh one.
    if (!isPlainObject(payload)) return null
    const { id, data, expiresAt } = payload as Partial<CookiePayload>
    if (typeof id !== 'string' || typeof expiresAt !== 'number' || !isPlainObject(data)) return null
    if (expiresAt <= this.now()) return null

    return { id, data }
  }

  // The session never leaves the cookie, so there is no keyed store behind it.
  // Thrown rather than inert: `SessionManager.store()` is public, and a caller
  // that reaches these has a wrong idea of where the session lives.
  async read(): Promise<SessionData | undefined> {
    throw new Error(this.keyedStoreError('read'))
  }

  async write(): Promise<void> {
    throw new Error(this.keyedStoreError('write'))
  }

  async destroy(): Promise<void> {
    throw new Error(this.keyedStoreError('destroy'))
  }

  private keyedStoreError(method: string): string {
    return `CookieSessionStore has no keyed store to ${method}: the session lives in the cookie, which the session `
      + 'middleware reads and writes through `inline`. Use a database- or Redis-backed store to look a session up by id.'
  }
}

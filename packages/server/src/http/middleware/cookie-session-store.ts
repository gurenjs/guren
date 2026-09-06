import { Encrypter } from '../../encryption/Encrypter'
import { deriveAppKeyring, getAppKeyringFromEnv, type AppKeyring } from '../../encryption/app-key'
import type { SessionData, SessionStore } from './session'

/** Browsers drop a cookie past ~4 KB, and a dropped session cookie is a silent logout. */
const DEFAULT_MAX_COOKIE_BYTES = 4096

export interface CookieSessionStoreOptions {
  /** Bytes the encoded value may occupy. @default 4096 */
  maxBytes?: number
  /** Clock for expiry, injectable for tests. @default Date.now */
  now?: () => number
  /** Overrides the keyring derived from `APP_KEY` / `APP_PREVIOUS_KEYS`. */
  keyring?: AppKeyring
}

interface CookiePayload {
  id: string
  data: SessionData
  /** Unix ms. Nothing server-side can expire a cookie early, so this is what makes the TTL real. */
  expiresAt: number
}

function encrypterFor(keyring: AppKeyring): Encrypter {
  const base64 = (key: Buffer): string => `base64:${key.toString('base64')}`
  return new Encrypter({
    key: base64(keyring.current),
    previousKeys: keyring.previous.map(base64),
    cipher: 'aes-256-gcm',
  })
}

/**
 * The whole session, encrypted inside the cookie under the app key: the one
 * store needing no server-side resource (RFC 0020 §3). Two limits the docs
 * state outright — everything in the session travels in the cookie, so it is
 * capped; and a logout cannot revoke a copy the client already has, so
 * anything revocable belongs in the database with only its id here.
 */
export class CookieSessionStore implements SessionStore {
  private readonly encrypter: Encrypter
  private readonly maxBytes: number
  private readonly now: () => number

  constructor(options: CookieSessionStoreOptions = {}) {
    this.encrypter = encrypterFor(options.keyring ?? deriveAppKeyring(getAppKeyringFromEnv(), 'cookie-session'))
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_COOKIE_BYTES
    this.now = options.now ?? (() => Date.now())
  }

  readonly inline = {
    encode: (id: string, data: SessionData, ttlSeconds: number): string => {
      const payload: CookiePayload = { id, data, expiresAt: this.now() + ttlSeconds * 1000 }
      const encoded = this.encrypter.encrypt(payload)

      // Thrown rather than truncated or emitted oversized: a browser that drops
      // the cookie logs the user out with nothing in the log to explain it.
      if (encoded.length > this.maxBytes) {
        throw new Error(
          `Session cookie is ${encoded.length} bytes, over the ${this.maxBytes}-byte limit. `
          + 'The cookie session store keeps the whole session in the cookie — keep large or revocable values in the '
          + 'database and only their ids in the session, or raise `maxBytes` if your platform allows it.',
        )
      }
      return encoded
    },

    decode: (cookieValue: string | undefined): { id: string; data: SessionData } | null => {
      if (!cookieValue) return null

      let payload: CookiePayload
      try {
        payload = this.encrypter.decrypt<CookiePayload>(cookieValue)
      } catch {
        // A cookie encrypted under a key outside the ring, or tampered with.
        return null
      }

      if (typeof payload?.id !== 'string' || typeof payload.expiresAt !== 'number') return null
      if (payload.expiresAt <= this.now()) return null

      return { id: payload.id, data: payload.data && typeof payload.data === 'object' ? payload.data : {} }
    },
  }

  // The session never leaves the cookie, so there is no keyed store behind it.
  // The middleware reads and writes through `inline` and never calls these.
  async read(): Promise<SessionData | undefined> {
    return undefined
  }

  async write(): Promise<void> {}

  async destroy(): Promise<void> {}
}

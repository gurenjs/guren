import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { deriveAppKeyring, getAppKeyringFromEnv } from '../../encryption/app-key'

export type SessionData = Record<string, unknown>

export interface SessionStore {
  /**
   * Read a session by its opaque identifier.
   * Returns undefined when the session does not exist or has expired.
   */
  read(id: string): Promise<SessionData | undefined>
  /**
   * Persist a session using upsert semantics for the given opaque identifier.
   */
  write(id: string, data: SessionData, ttlSeconds: number): Promise<void>
  /**
   * Destroy a session. Implementations must treat repeated calls as safe.
   */
  destroy(id: string): Promise<void>
}

export class MemorySessionStore implements SessionStore {
  private readonly store = new Map<string, { data: SessionData; expiresAt: number }>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  async read(id: string): Promise<SessionData | undefined> {
    const entry = this.store.get(id)
    if (!entry) {
      return undefined
    }

    if (entry.expiresAt <= this.now()) {
      this.store.delete(id)
      return undefined
    }

    return { ...entry.data }
  }

  async write(id: string, data: SessionData, ttlSeconds: number): Promise<void> {
    const expiresAt = this.now() + ttlSeconds * 1000
    this.store.set(id, { data: { ...data }, expiresAt })
  }

  async destroy(id: string): Promise<void> {
    this.store.delete(id)
  }
}

export interface SessionOptions {
  cookieName?: string
  cookiePath?: string
  cookieDomain?: string
  cookieSecure?: boolean
  cookieSameSite?: 'Strict' | 'Lax' | 'None'
  cookieHttpOnly?: boolean
  cookieMaxAgeSeconds?: number
  ttlSeconds?: number
  store?: SessionStore
}

const DEFAULT_COOKIE_NAME = 'guren.session'
const DEFAULT_TTL_SECONDS = 60 * 60 * 2 // 2 hours
const DEFAULT_COOKIE_SECURE = typeof process !== 'undefined'
  ? process.env.NODE_ENV === 'production'
  : true

const SESSION_CONTEXT_KEY = 'guren:session'

export interface Session {
  readonly id: string
  readonly isNew: boolean
  get<T = unknown>(key: string): T | undefined
  set<T = unknown>(key: string, value: T): void
  has(key: string): boolean
  forget(key: string): void
  flush(): void
  all(): SessionData
  regenerate(): void
  invalidate(): void
  flash(key: string, value: unknown): void
  getFlash<T = unknown>(key: string): T | undefined
  reflash(): void
  keep(...keys: string[]): void
}

interface FlashBag {
  new: Record<string, unknown>
  old: Record<string, unknown>
}

class SessionImpl implements Session {
  private currentId: string
  private readonly originalId: string
  private data: SessionData
  private dirty = false
  private destroyed = false
  private regenerated = false
  private _flash: FlashBag = { new: {}, old: {} }

  constructor(id: string, initialData: SessionData, readonly isNew: boolean) {
    this.currentId = id
    this.originalId = id
    // Separate flash bag from regular session data
    const { _flash, ...rest } = initialData
    this.data = { ...rest }
    if (_flash && typeof _flash === 'object') {
      const bag = _flash as Partial<FlashBag>
      this._flash = {
        new: bag.new && typeof bag.new === 'object' ? { ...bag.new } : {},
        old: bag.old && typeof bag.old === 'object' ? { ...bag.old } : {},
      }
    }
  }

  get id(): string {
    return this.currentId
  }

  get<T = unknown>(key: string): T | undefined {
    return this.data[key] as T | undefined
  }

  set<T = unknown>(key: string, value: T): void {
    this.data[key] = value as unknown
    this.dirty = true
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data, key)
  }

  forget(key: string): void {
    if (this.has(key)) {
      delete this.data[key]
      this.dirty = true
    }
  }

  flush(): void {
    if (Object.keys(this.data).length > 0) {
      this.data = {}
      this.dirty = true
    }
  }

  all(): SessionData {
    return { ...this.data }
  }

  regenerate(): void {
    this.currentId = globalThis.crypto.randomUUID()
    this.regenerated = true
    this.dirty = true
  }

  invalidate(): void {
    this.flush()
    this.destroyed = true
  }

  flash(key: string, value: unknown): void {
    this._flash.new[key] = value
    this.dirty = true
  }

  getFlash<T = unknown>(key: string): T | undefined {
    return this._flash.old[key] as T | undefined
  }

  reflash(): void {
    // Move all old flash data back to new so it survives another request
    for (const [key, value] of Object.entries(this._flash.old)) {
      this._flash.new[key] = value
    }
    this.dirty = true
  }

  keep(...keys: string[]): void {
    for (const key of keys) {
      if (key in this._flash.old) {
        this._flash.new[key] = this._flash.old[key]
      }
    }
    this.dirty = true
  }

  /**
   * Age flash data: move `new` → `old`, clear previous `old`.
   * Called at the start of each request by the session middleware.
   */
  ageFlashData(): void {
    this._flash.old = { ...this._flash.new }
    this._flash.new = {}
    this.dirty = true
  }

  markTouched(): void {
    this.dirty = true
  }

  wasDestroyed(): boolean {
    return this.destroyed
  }

  wasRegenerated(): boolean {
    return this.regenerated
  }

  shouldPersist(): boolean {
    return this.dirty || this.isNew
  }

  snapshot(): SessionData {
    const hasFlash =
      Object.keys(this._flash.new).length > 0 ||
      Object.keys(this._flash.old).length > 0
    return {
      ...this.data,
      ...(hasFlash ? { _flash: { new: { ...this._flash.new }, old: { ...this._flash.old } } } : {}),
    }
  }

  originalSessionId(): string {
    return this.originalId
  }
}

export interface CreateSessionMiddlewareOptions extends SessionOptions {}

const TESTING_SESSION_HEADER = 'x-testing-session'

function resolveTestingSession(ctx: { req: { header: (name: string) => string | undefined } }): SessionData | null {
  // Only allow testing session injection when GUREN_TESTING is explicitly set.
  // This prevents external callers from forging session state in production/staging.
  if (!process.env.GUREN_TESTING) {
    return null
  }

  const rawSession = ctx.req.header(TESTING_SESSION_HEADER)
  if (!rawSession) {
    return null
  }

  try {
    const parsed = JSON.parse(rawSession) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as SessionData
  } catch {
    return null
  }
}

interface SessionCookieSigner {
  sign(sessionId: string): string
  verify(cookieValue: string | undefined): string | null
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8')
}

function createCookieSigner(cookieName: string, cookiePath: string): SessionCookieSigner {
  const keyring = deriveAppKeyring(getAppKeyringFromEnv(), 'cookie-signing')
  const keys = [keyring.current, ...keyring.previous]

  const canonicalize = (encodedId: string): string => `${cookieName}|${cookiePath}|${encodedId}`

  const sign = (sessionId: string): string => {
    const encodedId = encodeBase64Url(sessionId)
    const signature = createHmac('sha256', keyring.current)
      .update(canonicalize(encodedId))
      .digest('base64url')
    return `${encodedId}.${signature}`
  }

  const verify = (cookieValue: string | undefined): string | null => {
    if (!cookieValue) {
      return null
    }

    const [encodedId, signature, extra] = cookieValue.split('.')
    if (!encodedId || !signature || extra) {
      return null
    }

    const canonical = canonicalize(encodedId)
    const matches = keys.some((key) => {
      const expected = createHmac('sha256', key).update(canonical).digest('base64url')
      const actualBuffer = Buffer.from(signature, 'utf8')
      const expectedBuffer = Buffer.from(expected, 'utf8')
      if (actualBuffer.length !== expectedBuffer.length) {
        return false
      }

      return timingSafeEqual(actualBuffer, expectedBuffer)
    })

    if (!matches) {
      return null
    }

    try {
      return decodeBase64Url(encodedId)
    } catch {
      return null
    }
  }

  return { sign, verify }
}

export function createSessionMiddleware(options: CreateSessionMiddlewareOptions = {}): MiddlewareHandler {
  const {
    cookieName = DEFAULT_COOKIE_NAME,
    cookiePath = '/',
    cookieDomain,
    cookieSecure = DEFAULT_COOKIE_SECURE,
    cookieSameSite = 'Lax',
    cookieHttpOnly = true,
    cookieMaxAgeSeconds,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    store = new MemorySessionStore(),
  } = options
  const signer = createCookieSigner(cookieName, cookiePath)

  return async (ctx, next) => {
    const existingId = signer.verify(getCookie(ctx, cookieName))
    const sessionId = existingId ?? globalThis.crypto.randomUUID()
    const isNew = !existingId
    const storedData = existingId ? (await store.read(existingId)) ?? {} : {}
    const testingData = resolveTestingSession(ctx)
    const initialData = testingData ? { ...storedData, ...testingData } : storedData
    const session = new SessionImpl(sessionId, initialData, isNew)
    session.ageFlashData()

    ctx.set(SESSION_CONTEXT_KEY, session)

    try {
      await next()
    } finally {
      if (session.wasDestroyed()) {
        await store.destroy(session.originalSessionId())
        deleteCookie(ctx, cookieName, {
          path: cookiePath,
          domain: cookieDomain,
          secure: cookieSecure,
          sameSite: cookieSameSite,
          httpOnly: cookieHttpOnly,
        })
        return
      }

      if (!session.shouldPersist()) {
        if (existingId) {
          await store.write(existingId, session.snapshot(), ttlSeconds)

          setCookie(ctx, cookieName, signer.sign(existingId), {
            path: cookiePath,
            domain: cookieDomain,
            secure: cookieSecure,
            sameSite: cookieSameSite,
            httpOnly: cookieHttpOnly,
            maxAge: cookieMaxAgeSeconds ?? ttlSeconds,
          })
        }
        return
      }

      const nextId = session.id
      await store.write(nextId, session.snapshot(), ttlSeconds)
      if (session.wasRegenerated() && session.originalSessionId() !== nextId) {
        await store.destroy(session.originalSessionId())
      }

      setCookie(ctx, cookieName, signer.sign(nextId), {
        path: cookiePath,
        domain: cookieDomain,
        secure: cookieSecure,
        sameSite: cookieSameSite,
        httpOnly: cookieHttpOnly,
        maxAge: cookieMaxAgeSeconds ?? ttlSeconds,
      })
    }
  }
}

export function getSessionFromContext<T extends Session = Session>(ctx: { get: (key: string) => unknown }): T | undefined {
  return ctx.get(SESSION_CONTEXT_KEY) as T | undefined
}

export { SESSION_CONTEXT_KEY }

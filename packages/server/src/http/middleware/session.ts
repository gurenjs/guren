import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { deriveAppKeyring, getAppKeyringFromEnv } from '../../encryption/app-key'
import { detectServerlessRuntime, SERVERLESS_RUNTIME_LABELS } from '../../runtime/serverless'

export type SessionData = Record<string, unknown>

export interface SessionStore {
  /** Returns undefined when the session does not exist or has expired. */
  read(id: string): Promise<SessionData | undefined>
  /** Persist a session using upsert semantics. */
  write(id: string, data: SessionData, ttlSeconds: number): Promise<void>
  /** Implementations must treat repeated calls as safe. */
  destroy(id: string): Promise<void>
  /**
   * Refresh an existing session's TTL without rewriting its data (rolling
   * expiry); stores omitting it fall back to a full `write`. Refreshing a
   * session that does not exist must be a no-op, not a resurrection.
   */
  touch?(id: string, ttlSeconds: number): Promise<void>
  /**
   * Present on stores that keep the session *inside* the cookie (RFC 0020 §3).
   * The middleware then writes `encode()`'s value as the cookie instead of a
   * signed id and reads the next request's back through `decode()`, so
   * `read`/`write`/`destroy` are never called: there is no keyed store behind it.
   */
  inline?: SessionInlineCodec
}

export interface SessionInlineCodec {
  /** Throws when the session cannot fit the cookie, rather than emitting one a browser drops. */
  encode(id: string, data: SessionData, ttlSeconds: number): string
  /** Null for a missing, expired, tampered, or undecryptable cookie. */
  decode(cookieValue: string | undefined): { id: string; data: SessionData } | null
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

  async touch(id: string, ttlSeconds: number): Promise<void> {
    const entry = this.store.get(id)
    if (!entry || entry.expiresAt <= this.now()) {
      return
    }
    entry.expiresAt = this.now() + ttlSeconds * 1000
  }
}

/** Everything about the cookie and its lifetime; the store is a separate concern. */
export interface SessionCookieOptions {
  cookieName?: string
  cookiePath?: string
  cookieDomain?: string
  cookieSecure?: boolean
  cookieSameSite?: 'Strict' | 'Lax' | 'None'
  cookieHttpOnly?: boolean
  cookieMaxAgeSeconds?: number
  ttlSeconds?: number
}

export interface SessionOptions extends SessionCookieOptions {
  /**
   * The store, or a function returning it, called on every request and never
   * at construction: a Workers binding does not exist before the first request
   * (RFC 0020 §1). `SessionManager.store()` memoizes; a hand-written factory
   * that builds something expensive should memoize too.
   */
  store?: SessionStore | (() => SessionStore)
}

const DEFAULT_COOKIE_NAME = 'guren.session'
const DEFAULT_TTL_SECONDS = 60 * 60 * 2 // 2 hours

/**
 * Read when a middleware is built, not when this module loads: an app that
 * sets NODE_ENV after importing the framework (tests, some serverless
 * bootstraps) must still get a Secure cookie. Spelled `process.env.NODE_ENV`
 * exactly, so the deploy plugins' `--define` settles it at bundle time.
 */
export function defaultCookieSecure(): boolean {
  return typeof process !== 'undefined' ? process.env.NODE_ENV === 'production' : true
}

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
  /**
   * Rotate the session id (call after login to mitigate session fixation); the
   * old one is destroyed at request end. Every multi-process store shares one
   * limitation: a concurrent request on the old cookie can re-persist the old
   * id, whose row holds only pre-rotation data and lingers until it expires.
   */
  regenerate(): void
  invalidate(): void
  /**
   * Whether this session survives the current response under `id`. A session
   * created *during* the request stays `isNew` for its lifetime yet is
   * persisted once a handler writes to it, so anything anchoring a value to the
   * session id (CSRF token binding) must ask this, not `!isNew`. Optional only
   * so a custom `Session` predating it type-checks; the `!isNew` fallback has that bug, so implement it.
   */
  willPersist?(): boolean
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
   * Called at the start of each request by the session middleware. Only dirties
   * the session when there was flash data to age, or every request carrying a
   * session would persist unconditionally.
   */
  ageFlashData(): void {
    const hadFlash = this.hasFlash()
    this._flash.old = { ...this._flash.new }
    this._flash.new = {}
    if (hadFlash) {
      this.dirty = true
    }
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
    // Empty brand-new sessions are not persisted: an anonymous request that
    // never stores anything must not cost a database write (or a cookie).
    return this.dirty || (this.isNew && this.hasContent())
  }

  willPersist(): boolean {
    if (this.destroyed) {
      return false
    }

    // An established session survives untouched (rolling expiry refreshes its
    // TTL); a brand-new one only once something has written to it.
    return !this.isNew || this.shouldPersist()
  }

  private hasContent(): boolean {
    return Object.keys(this.data).length > 0 || this.hasFlash()
  }

  private hasFlash(): boolean {
    return (
      Object.keys(this._flash.new).length > 0 ||
      Object.keys(this._flash.old).length > 0
    )
  }

  snapshot(): SessionData {
    const hasFlash = this.hasFlash()
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

/**
 * The static checks can be skipped; this runs in the deploy log of exactly the
 * app they would have warned about (RFC 0020 §1). Decided once per middleware,
 * on its first request. `vercel dev` is one process, so there the warning
 * would be noise; `sam local` starts a container per invocation by default,
 * so there it is true.
 */
function warnAboutMemoryStore(store: SessionStore): void {
  if (!(store instanceof MemorySessionStore)) {
    return
  }
  const runtime = detectServerlessRuntime()
  if (!runtime || runtime.emulator === 'vercel-dev') {
    return
  }
  console.warn(
    `[guren] Sessions use MemorySessionStore on ${SERVERLESS_RUNTIME_LABELS[runtime.id]}, which shares no memory between requests, `
    + 'so a login is lost on the very next request. Configure a persistent store: DatabaseSessionStore '
    + 'from @guren/core, or a SessionManager whose default store is database- or Redis-backed.',
  )
}

export function createSessionMiddleware(options: CreateSessionMiddlewareOptions = {}): MiddlewareHandler {
  const {
    cookieName = DEFAULT_COOKIE_NAME,
    cookiePath = '/',
    cookieDomain,
    cookieSecure = defaultCookieSecure(),
    cookieSameSite = 'Lax',
    cookieHttpOnly = true,
    cookieMaxAgeSeconds,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    store: storeOrFactory = new MemorySessionStore(),
  } = options
  const signer = createCookieSigner(cookieName, cookiePath)
  let checkedStore = false

  return async (ctx, next) => {
    // Every request, not memoized: the factory is the authority on which store
    // is current (a SessionManager rebuilds one when its driver is re-registered).
    const store: SessionStore = typeof storeOrFactory === 'function' ? storeOrFactory() : storeOrFactory
    if (!checkedStore) {
      checkedStore = true
      warnAboutMemoryStore(store)
    }
    // An inline store carries the session in the cookie, so the id and the data
    // arrive together and there is nothing to look up.
    const inline = store.inline
    const decoded = inline ? inline.decode(getCookie(ctx, cookieName)) : null
    const cookieValueFor = (id: string, data: SessionData): string =>
      inline ? inline.encode(id, data, ttlSeconds) : signer.sign(id)
    const existingId = inline ? decoded?.id ?? null : signer.verify(getCookie(ctx, cookieName))
    const sessionId = existingId ?? globalThis.crypto.randomUUID()
    const isNew = !existingId
    const storedData = inline
      ? decoded?.data ?? {}
      : existingId ? (await store.read(existingId)) ?? {} : {}
    const testingData = resolveTestingSession(ctx)
    const initialData = testingData ? { ...storedData, ...testingData } : storedData
    const session = new SessionImpl(sessionId, initialData, isNew)
    session.ageFlashData()

    ctx.set(SESSION_CONTEXT_KEY, session)

    try {
      await next()
    } finally {
      // No `return` in here: returning from a `finally` discards whatever
      // `next()` threw, and the exception handler would never see it.
      if (session.wasDestroyed()) {
        // Nothing server-side holds an inline session, so clearing the cookie
        // is the whole of it — on this client only, which the docs state.
        if (!inline) await store.destroy(session.originalSessionId())
        deleteCookie(ctx, cookieName, {
          path: cookiePath,
          domain: cookieDomain,
          secure: cookieSecure,
          sameSite: cookieSameSite,
          httpOnly: cookieHttpOnly,
        })
      } else if (!session.shouldPersist()) {
        if (existingId) {
          // Rolling expiry for an unchanged session: a TTL refresh, not a
          // full rewrite, when the store supports it. An inline session's
          // expiry lives in the cookie, so re-encoding *is* the refresh.
          if (!inline) {
            if (store.touch) {
              await store.touch(existingId, ttlSeconds)
            } else {
              await store.write(existingId, session.snapshot(), ttlSeconds)
            }
          }

          setCookie(ctx, cookieName, cookieValueFor(existingId, session.snapshot()), {
            path: cookiePath,
            domain: cookieDomain,
            secure: cookieSecure,
            sameSite: cookieSameSite,
            httpOnly: cookieHttpOnly,
            maxAge: cookieMaxAgeSeconds ?? ttlSeconds,
          })
        }
      } else {
        const nextId = session.id
        const snapshot = session.snapshot()
        if (!inline) {
          await store.write(nextId, snapshot, ttlSeconds)
          // A concurrent request on the old cookie can re-persist the old id after
          // this destroy; see `regenerate()` for why that does not escalate.
          if (session.wasRegenerated() && session.originalSessionId() !== nextId) {
            await store.destroy(session.originalSessionId())
          }
        }

        setCookie(ctx, cookieName, cookieValueFor(nextId, snapshot), {
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
}

export function getSessionFromContext<T extends Session = Session>(ctx: { get: (key: string) => unknown }): T | undefined {
  return ctx.get(SESSION_CONTEXT_KEY) as T | undefined
}

export { SESSION_CONTEXT_KEY }

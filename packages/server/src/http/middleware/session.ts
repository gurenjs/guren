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
   * Bytes the whole `Set-Cookie` may occupy before the middleware refuses it.
   * Browsers drop a larger one, and a dropped session cookie is a silent logout.
   * @default 4096
   */
  maxCookieBytes?: number
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
/** What browsers keep per cookie; a larger one is dropped, which reads as a logout. */
const DEFAULT_MAX_COOKIE_BYTES = 4096

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

/**
 * How a session reaches the client: as a signed id over a keyed store, or
 * carried whole inside the cookie. Chosen once per request, so the persistence
 * block below never asks which one it has.
 */
interface SessionTransport {
  load(cookieValue: string | undefined): Promise<{ id: string; data: SessionData } | null>
  /** The cookie value for an unchanged session, whose expiry still rolls forward. */
  refresh(id: string, session: SessionImpl): Promise<string>
  persist(id: string, data: SessionData, context: { regeneratedFrom: string | null }): Promise<string>
  discard(id: string): Promise<void>
}

function keyedTransport(store: SessionStore, signer: SessionCookieSigner, ttlSeconds: number): SessionTransport {
  return {
    async load(cookieValue) {
      const id = signer.verify(cookieValue)
      return id === null ? null : { id, data: (await store.read(id)) ?? {} }
    },
    async refresh(id, session) {
      // A TTL refresh rather than a full rewrite, when the store supports it.
      if (store.touch) {
        await store.touch(id, ttlSeconds)
      } else {
        await store.write(id, session.snapshot(), ttlSeconds)
      }
      return signer.sign(id)
    },
    async persist(id, data, { regeneratedFrom }) {
      await store.write(id, data, ttlSeconds)
      // A concurrent request on the old cookie can re-persist the old id after
      // this destroy; see `regenerate()` for why that does not escalate.
      if (regeneratedFrom !== null && regeneratedFrom !== id) {
        await store.destroy(regeneratedFrom)
      }
      return signer.sign(id)
    },
    async discard(id) {
      await store.destroy(id)
    },
  }
}

function inlineTransport(codec: SessionInlineCodec, ttlSeconds: number): SessionTransport {
  return {
    async load(cookieValue) {
      return codec.decode(cookieValue)
    },
    async refresh(id, session) {
      // The expiry lives in the cookie, so re-encoding *is* the refresh.
      return codec.encode(id, session.snapshot(), ttlSeconds)
    },
    async persist(id, data) {
      // Nothing server-side holds the old session, so a regeneration leaves
      // nothing to destroy: the previous cookie simply stops being sent.
      return codec.encode(id, data, ttlSeconds)
    },
    async discard() {},
  }
}

/**
 * What the `Set-Cookie` header will cost, name and attributes included. The
 * browser limit applies to the whole thing, so measuring only the value is how
 * a session passes its own check and is then dropped without a word.
 */
function assembledCookieBytes(
  name: string,
  value: string,
  options: { path?: string; domain?: string; secure?: boolean; sameSite?: string; httpOnly?: boolean },
  maxAge: number,
): number {
  const attributes = [
    options.path ? `; Path=${options.path}` : '',
    options.domain ? `; Domain=${options.domain}` : '',
    `; Max-Age=${maxAge}`,
    options.httpOnly ? '; HttpOnly' : '',
    options.secure ? '; Secure' : '',
    options.sameSite ? `; SameSite=${options.sameSite}` : '',
  ].join('')
  return Buffer.byteLength(`${name}=${encodeURIComponent(value)}${attributes}`, 'utf8')
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
    maxCookieBytes = DEFAULT_MAX_COOKIE_BYTES,
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
    // Which transport carries the session is decided once; nothing below asks again.
    const transport = store.inline
      ? inlineTransport(store.inline, ttlSeconds)
      : keyedTransport(store, signer, ttlSeconds)
    const loaded = await transport.load(getCookie(ctx, cookieName))
    const existingId = loaded?.id ?? null
    const sessionId = existingId ?? globalThis.crypto.randomUUID()
    const isNew = !existingId
    const storedData = loaded?.data ?? {}
    const testingData = resolveTestingSession(ctx)
    const initialData = testingData ? { ...storedData, ...testingData } : storedData
    const session = new SessionImpl(sessionId, initialData, isNew)
    session.ageFlashData()

    ctx.set(SESSION_CONTEXT_KEY, session)

    // Measured against hono 4.13: `await next()` never throws — a handler's or
    // a downstream middleware's error is settled at dispatch — so there is no
    // in-flight exception here to preserve, and none to lose.
    await next()

    const cookieOptions = {
      path: cookiePath,
      domain: cookieDomain,
      secure: cookieSecure,
      sameSite: cookieSameSite,
      httpOnly: cookieHttpOnly,
    }

    const persistSession = async (): Promise<void> => {
      if (session.wasDestroyed()) {
        await transport.discard(session.originalSessionId())
        deleteCookie(ctx, cookieName, cookieOptions)
        return
      }

      if (!session.shouldPersist()) {
        // An untouched session still rolls its expiry forward, and only one
        // that already exists has a cookie to refresh.
        if (existingId) {
          setCookie(ctx, cookieName, await write(transport.refresh(existingId, session)), {
            ...cookieOptions,
            maxAge: cookieMaxAgeSeconds ?? ttlSeconds,
          })
        }
        return
      }

      const nextId = session.id
      const value = await transport.persist(nextId, session.snapshot(), {
        regeneratedFrom: session.wasRegenerated() ? session.originalSessionId() : null,
      })
      setCookie(ctx, cookieName, await write(value), {
        ...cookieOptions,
        maxAge: cookieMaxAgeSeconds ?? ttlSeconds,
      })
    }

    /** Refuses a value whose `Set-Cookie` would exceed what a browser keeps. */
    const write = async (value: string | Promise<string>): Promise<string> => {
      const resolved = await value
      const bytes = assembledCookieBytes(cookieName, resolved, cookieOptions, cookieMaxAgeSeconds ?? ttlSeconds)
      if (bytes > maxCookieBytes) {
        throw new Error(
          `The session cookie would be ${bytes} bytes, over the ${maxCookieBytes}-byte limit browsers keep. `
          + 'A cookie session carries the whole session — keep large or revocable values in the database and only '
          + 'their ids in the session, or raise `maxCookieBytes`.',
        )
      }
      return resolved
    }

    // Thrown, not swallowed: a session the client will not keep must not look
    // stored. Every store's write can fail this way; the cookie transport just
    // fails more predictably.
    await persistSession()
  }
}

export function getSessionFromContext<T extends Session = Session>(ctx: { get: (key: string) => unknown }): T | undefined {
  return ctx.get(SESSION_CONTEXT_KEY) as T | undefined
}

export { SESSION_CONTEXT_KEY }

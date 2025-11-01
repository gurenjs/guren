import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { MiddlewareHandler } from 'hono'

export type SessionData = Record<string, unknown>

export interface SessionStore {
  read(id: string): Promise<SessionData | undefined>
  write(id: string, data: SessionData, ttlSeconds: number): Promise<void>
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
}

class SessionImpl implements Session {
  private currentId: string
  private readonly originalId: string
  private data: SessionData
  private dirty = false
  private destroyed = false
  private regenerated = false

  constructor(id: string, initialData: SessionData, readonly isNew: boolean) {
    this.currentId = id
    this.originalId = id
    this.data = { ...initialData }
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
    return { ...this.data }
  }

  originalSessionId(): string {
    return this.originalId
  }
}

export interface CreateSessionMiddlewareOptions extends SessionOptions {}

export function createSessionMiddleware(options: CreateSessionMiddlewareOptions = {}): MiddlewareHandler {
  const {
    cookieName = DEFAULT_COOKIE_NAME,
    cookiePath = '/',
    cookieDomain,
    cookieSecure = true,
    cookieSameSite = 'Lax',
    cookieHttpOnly = true,
    cookieMaxAgeSeconds,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    store = new MemorySessionStore(),
  } = options

  return async (ctx, next) => {
    const existingId = getCookie(ctx, cookieName)
    const sessionId = existingId ?? globalThis.crypto.randomUUID()
    const isNew = !existingId
    const initialData = existingId ? (await store.read(existingId)) ?? {} : {}
    const session = new SessionImpl(sessionId, initialData, isNew)

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

          setCookie(ctx, cookieName, existingId, {
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

      setCookie(ctx, cookieName, nextId, {
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

import { Hono } from 'hono'
import { createSessionMiddleware, getSessionFromContext, type Session } from '../../src/http/middleware/session'

/** An in-memory Session for a guard built outside the middleware. */
export function fakeSession(): Session {
  const data = new Map<string, unknown>()
  return {
    id: 'sid',
    isNew: false,
    get: (key: string) => data.get(key),
    set: (key: string, value: unknown) => data.set(key, value),
    forget: (key: string) => data.delete(key),
    has: (key: string) => data.has(key),
    all: () => Object.fromEntries(data),
    flush: () => data.clear(),
    regenerate: () => {},
    invalidate: () => {},
    flash: () => {},
    getFlash: () => undefined,
    reflash: () => {},
    keep: () => {},
  } as unknown as Session
}

/** One route at `/` behind the session middleware; `onRequest` sees the request's session. */
export function sessionApp(
  options: Parameters<typeof createSessionMiddleware>[0],
  onRequest?: (session: Session) => void,
): Hono {
  const app = new Hono()
  app.use('*', createSessionMiddleware(options))
  app.get('/', (c) => {
    onRequest?.(getSessionFromContext(c)!)
    return c.text('ok')
  })
  return app
}

/** The `name=value` pair a response's Set-Cookie carries, for replaying as a request header. */
export function sessionCookiePair(response: Response): string | undefined {
  return response.headers.get('set-cookie')?.split(';')[0]
}

/** Just the value. Split on the first `=` only: base64url has none, but base64 padding does. */
export function sessionCookieValue(response: Response): string | undefined {
  const pair = sessionCookiePair(response)
  if (pair === undefined) return undefined
  const separator = pair.indexOf('=')
  return decodeURIComponent(pair.slice(separator + 1))
}

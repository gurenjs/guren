import { AUTH_CONTEXT_KEY, createRateLimitMiddleware, getRequestTranslator, ValidationException } from '@guren/core'
import type { AuthContext, Context, Middleware } from '@guren/core'

interface ThrottleOptions {
  /** Requests allowed per key within the window. */
  limit: number
  windowMs: number
  /** Translation key; `:seconds` is replaced with the wait. */
  messageKey: string
  fallbackMessage: string
  /** Defaults to the client IP and the submitted email. */
  key?: (ctx: Context) => Promise<string>
  /** A request this returns true for is not counted. */
  skip?: (ctx: Context) => Promise<boolean>
  /** The form field an Inertia request shows the message under. */
  errorField?: string
}

interface BunServerEnv {
  server?: { requestIP?(request: Request): { address: string } | null }
}

// Behind a proxy or CDN every client shares its address: read the header your
// proxy sets (and strips from client requests) here instead.
function clientIp(ctx: Context): string | undefined {
  return (ctx.env as BunServerEnv | undefined)?.server?.requestIP?.(ctx.req.raw)?.address
}

// Hono caches the parsed body, so the controller still reads it after this.
// `undefined` when the body cannot be read as an object.
async function submittedBody(ctx: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = (ctx.req.header('content-type') ?? '').includes('application/json')
      ? await ctx.req.json()
      : await ctx.req.parseBody()
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

async function submittedEmail(ctx: Context): Promise<string | undefined> {
  const email = (await submittedBody(ctx))?.email
  return typeof email === 'string' ? email.trim().toLowerCase() : undefined
}

function throttleMessage(ctx: Context, options: ThrottleOptions, seconds: number): string {
  const translated = getRequestTranslator(ctx)?.t(options.messageKey, { seconds })
  return translated && translated !== options.messageKey
    ? translated
    : options.fallbackMessage.replace(':seconds', String(seconds))
}

/**
 * Counts every request `skip` lets through, per `key`. The default store lives
 * in process memory: pass `store: new RedisRateLimitStore(redis)` (from
 * `@guren/core/redis`) to share counts across instances.
 */
function authThrottle(name: string, options: ThrottleOptions): Middleware {
  // Built on the first request: the default store starts a sweep timer, which
  // Cloudflare Workers refuses while a module is being evaluated.
  let limiter: Middleware | undefined
  return (ctx, next) => {
    limiter ??= createRateLimitMiddleware({
      limit: options.limit,
      windowMs: options.windowMs,
      keyPrefix: `auth:${name}:`,
      keyGenerator: options.key ?? (async (ctx) => `${clientIp(ctx) ?? 'unknown'}|${(await submittedEmail(ctx)) ?? ''}`),
      skip: options.skip,
      onRateLimited: (ctx, retryAfter) => {
        const message = throttleMessage(ctx, options, retryAfter)
        // An Inertia form shows a flashed error; a bare 429 would open its error modal.
        if (ctx.req.header('x-inertia') === 'true') {
          throw ValidationException.withMessages({ [options.errorField ?? 'message']: message })
        }
        return ctx.json({ message, retryAfter }, 429)
      },
    })
    return limiter(ctx, next)
  }
}

export const throttleLogin = authThrottle('login', {
  limit: 5,
  windowMs: 60_000,
  messageKey: 'auth.throttle',
  fallbackMessage: 'Too many login attempts. Please try again in :seconds seconds.',
})

export const throttleRegistration = authThrottle('register', {
  limit: 5,
  windowMs: 60_000,
  messageKey: 'auth.too_many_requests',
  fallbackMessage: 'Too many requests. Please try again in :seconds seconds.',
})

export const throttlePasswordResetRequest = authThrottle('forgot-password', {
  limit: 3,
  windowMs: 15 * 60_000,
  messageKey: 'auth.too_many_requests',
  fallbackMessage: 'Too many requests. Please try again in :seconds seconds.',
})

// Per signed-in user, so a stolen session cannot guess the current password the
// profile form asks for. Only a request carrying one reaches that check.
export const throttleProfileUpdate = authThrottle('profile', {
  limit: 5,
  windowMs: 60_000,
  messageKey: 'auth.too_many_requests',
  fallbackMessage: 'Too many requests. Please try again in :seconds seconds.',
  key: async (ctx) => {
    const id = await (ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined)?.id()
    return id === undefined || id === null ? `ip:${clientIp(ctx) ?? 'unknown'}` : `user:${String(id)}`
  },
  // Mirrors the controller's `currentPassword === ''`; an unreadable body is counted.
  skip: async (ctx) => {
    const body = await submittedBody(ctx)
    return body !== undefined && (body.currentPassword === undefined || body.currentPassword === '')
  },
  errorField: 'currentPassword',
})

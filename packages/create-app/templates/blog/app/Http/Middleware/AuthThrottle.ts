import { createRateLimitMiddleware, getRequestTranslator, ValidationException } from '@guren/core'
import type { Context, Middleware } from '@guren/core'

interface ThrottleOptions {
  /** Requests allowed per client and email address within the window. */
  limit: number
  windowMs: number
  /** Translation key; `:seconds` is replaced with the wait. */
  messageKey: string
  fallbackMessage: string
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
async function submittedEmail(ctx: Context): Promise<string | undefined> {
  try {
    const body: unknown = (ctx.req.header('content-type') ?? '').includes('application/json')
      ? await ctx.req.json()
      : await ctx.req.parseBody()
    const email = (body as Record<string, unknown> | null)?.email
    return typeof email === 'string' ? email.trim().toLowerCase() : undefined
  } catch {
    return undefined
  }
}

function throttleMessage(ctx: Context, options: ThrottleOptions, seconds: number): string {
  const translated = getRequestTranslator(ctx)?.t(options.messageKey, { seconds })
  return translated && translated !== options.messageKey
    ? translated
    : options.fallbackMessage.replace(':seconds', String(seconds))
}

/**
 * Counts every request, keyed per client IP and submitted email. The default
 * store lives in process memory: pass `store: new RedisRateLimitStore(redis)`
 * (from `@guren/core/redis`) to share counts across instances.
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
      keyGenerator: async (ctx) => `${clientIp(ctx) ?? 'unknown'}|${(await submittedEmail(ctx)) ?? ''}`,
      onRateLimited: (ctx, retryAfter) => {
        const message = throttleMessage(ctx, options, retryAfter)
        // An Inertia form shows a flashed error; a bare 429 would open its error modal.
        if (ctx.req.header('x-inertia') === 'true') {
          throw ValidationException.withMessages({ message })
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

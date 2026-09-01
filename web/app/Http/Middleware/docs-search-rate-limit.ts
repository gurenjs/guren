import { createRateLimitMiddleware, MemoryRateLimitStore } from '@guren/core'
import type { Context } from '@guren/core'

/**
 * `/docs/search` is the only public endpoint here that reaches the database,
 * and it does so per keystroke. This bounds one client's share of D1's daily
 * read budget.
 *
 * Honest about what it is: the store is per-isolate memory, and Workers runs
 * many isolates, so the effective ceiling is higher than the number below and
 * varies. It stops a loop hammering the endpoint, which is what it is for;
 * Cloudflare's own protections are the perimeter.
 */
const REQUESTS_PER_MINUTE = 60

/**
 * The framework default reads `server.requestIP()`, which only Bun provides —
 * on Workers it would fall back to one shared bucket for every visitor, and
 * the first burst would lock the endpoint for everyone. Cloudflare puts the
 * client address in `CF-Connecting-IP`, and it is set by the edge rather than
 * by the caller.
 */
export function docsSearchRateLimitKey(ctx: Context): string {
  const forwarded = ctx.req.header('cf-connecting-ip')
  if (forwarded) {
    return forwarded
  }

  const env = ctx.env as { server?: { requestIP?: (request: Request) => { address?: string } | null } } | undefined
  const address = env?.server?.requestIP?.(ctx.req.raw)?.address
  return address ?? '__shared__'
}

export const docsSearchRateLimit = createRateLimitMiddleware({
  limit: REQUESTS_PER_MINUTE,
  windowMs: 60_000,
  keyGenerator: docsSearchRateLimitKey,
  // Zero disables the sweep timer. This module is evaluated while the Worker's
  // global scope is still running, where Cloudflare disallows timers outright;
  // expired entries are dropped on read instead.
  store: new MemoryRateLimitStore(0),
  keyPrefix: 'docs-search:',
  message: 'Too many searches. Try again in a moment.',
})

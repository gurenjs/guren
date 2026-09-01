import { createRateLimitMiddleware, MemoryRateLimitStore } from '@guren/core'
import type { Context, RateLimitEntry, RateLimitStore } from '@guren/core'

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
  const connectingIp = ctx.req.header('cf-connecting-ip')
  if (connectingIp) {
    return connectingIp
  }

  const env = ctx.env as { server?: { requestIP?: (request: Request) => { address?: string } | null } } | undefined
  const address = env?.server?.requestIP?.(ctx.req.raw)?.address
  return address ?? '__shared__'
}

/** Writes between sweeps. Small enough to bound the map, large enough to be rare. */
const SWEEP_EVERY = 256

/**
 * The memory store, minus its timer, plus a sweep it drives itself.
 *
 * The timer has to go: this module is evaluated while the Worker's global
 * scope is still running, and Cloudflare disallows timers there. But the
 * store only drops an expired entry when that same key is seen again, and
 * the key here is a visitor's address — so an isolate would hold one entry
 * per address it had ever served, for as long as it lived. Sweeping on write
 * keeps the map proportional to recent traffic instead of to all of it.
 */
export class SweepingRateLimitStore implements RateLimitStore {
  readonly #entries: MemoryRateLimitStore
  #writesSinceSweep = 0

  constructor(now: () => number = () => Date.now()) {
    this.#entries = new MemoryRateLimitStore(0, now)
  }

  get size(): number {
    return this.#entries.size
  }

  async get(key: string): Promise<RateLimitEntry | null> {
    return this.#entries.get(key)
  }

  async increment(key: string, windowMs: number): Promise<RateLimitEntry> {
    if (++this.#writesSinceSweep >= SWEEP_EVERY) {
      this.#writesSinceSweep = 0
      this.#entries.cleanup()
    }
    return this.#entries.increment(key, windowMs)
  }

  async reset(key: string): Promise<void> {
    return this.#entries.reset(key)
  }
}

export const docsSearchRateLimit = createRateLimitMiddleware({
  limit: REQUESTS_PER_MINUTE,
  windowMs: 60_000,
  keyGenerator: docsSearchRateLimitKey,
  store: new SweepingRateLimitStore(),
  keyPrefix: 'docs-search:',
  message: 'Too many searches. Try again in a moment.',
})

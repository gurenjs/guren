/**
 * Per-token rate limiting for the App MCP endpoint (RFC 0016 §5.3), on by
 * default with a stricter budget for non-read-only tools. A fixed window per
 * key, in process memory: a fleet or serverless deployment enforces it per
 * instance, not as a global budget — that needs a shared store and belongs to
 * the app's own rate-limit middleware.
 */

export interface RateLimitConfig {
  /** Calls allowed per window, per token. @default 60 */
  max?: number
  /** Of which, calls to non-read-only tools. @default 20 */
  writeMax?: number
  /** Window length in milliseconds. @default 60_000 */
  windowMs?: number
}

interface WindowState {
  startedAt: number
  total: number
  writes: number
}

export class AgentRateLimiter {
  private readonly max: number
  private readonly writeMax: number
  private readonly windowMs: number
  private readonly windows = new Map<string, WindowState>()

  constructor(config: RateLimitConfig = {}) {
    this.max = config.max ?? 60
    this.writeMax = config.writeMax ?? 20
    this.windowMs = config.windowMs ?? 60_000
  }

  /**
   * Take one call from `key`'s current window. Returns false — without
   * consuming anything — when the budget is exhausted.
   */
  take(key: string, options: { write: boolean; now?: number }): boolean {
    const now = options.now ?? Date.now()
    const current = this.windows.get(key)
    const window = current && now - current.startedAt < this.windowMs
      ? current
      : { startedAt: now, total: 0, writes: 0 }

    if (window.total >= this.max) return false
    if (options.write && window.writes >= this.writeMax) return false

    window.total += 1
    if (options.write) window.writes += 1
    this.windows.set(key, window)

    // An abandoned key's window is replaced on its next use; sweep
    // opportunistically so token churn cannot grow the map without bound.
    if (this.windows.size > 10_000) {
      for (const [candidate, state] of this.windows) {
        if (now - state.startedAt >= this.windowMs) this.windows.delete(candidate)
      }
    }

    return true
  }
}

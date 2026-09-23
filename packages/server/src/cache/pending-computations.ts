import type { CacheStore } from './types'

/**
 * Callers do not join a computation this old: a callback that never settles
 * would otherwise hold every later caller for the key until restart. The
 * callers already waiting stay attached. Mirrored in the cache guide.
 */
export const PENDING_JOIN_WINDOW_MS = 10_000

interface Pending {
  readonly promise: Promise<unknown>
  readonly startedAt: number
}

/**
 * One running computation per key and TTL, shared by the callers that ask
 * while it runs. The TTL is part of the match because it is what the
 * computation stores: a caller asking for 60 seconds must not get a forever entry.
 */
export class PendingComputations {
  // Grouped by key so that forget(key) drops every TTL at once.
  private readonly pending = new Map<string, Map<number | undefined, Pending>>()

  constructor(private readonly now: () => number = Date.now) {}

  run<T>(key: string, ttl: number | undefined, compute: () => Promise<T>): Promise<T> {
    const now = this.now()
    const current = this.pending.get(key)?.get(ttl)
    const entry = current && now - current.startedAt < PENDING_JOIN_WINDOW_MS ? current : this.start(key, ttl, compute, now)
    // A promise per caller, so a rejection nobody awaits is still reported as unhandled.
    return entry.promise.then() as Promise<T>
  }

  private start(key: string, ttl: number | undefined, compute: () => Promise<unknown>, now: number): Pending {
    const entry: Pending = { promise: new Promise((resolve) => resolve(compute())), startedAt: now }
    let byTtl = this.pending.get(key)
    if (!byTtl) {
      byTtl = new Map()
      this.pending.set(key, byTtl)
    }
    byTtl.set(ttl, entry)

    const settle = () => {
      const current = this.pending.get(key)
      if (current?.get(ttl) !== entry) return
      current.delete(ttl)
      if (current.size === 0) this.pending.delete(key)
    }
    entry.promise.then(settle, settle)
    return entry
  }

  forget(key: string): void {
    this.pending.delete(key)
  }

  forgetAll(): void {
    this.pending.clear()
  }
}

// Keyed by the store that holds the data, so every wrapper and tagged cache
// over one store shares its computations, and keyed by the key that store sees.
const byStore = new WeakMap<CacheStore, PendingComputations>()

export function pendingComputationsFor(store: CacheStore): PendingComputations {
  let computations = byStore.get(store)
  if (!computations) {
    computations = new PendingComputations()
    byStore.set(store, computations)
  }
  return computations
}

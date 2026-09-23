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

export interface PendingComputationsOptions {
  /** Epoch milliseconds. @default Date.now */
  now?: () => number
  /** @default PENDING_JOIN_WINDOW_MS */
  joinWindowMs?: number
}

/** One running computation per key, shared by the callers that ask while it runs. */
export class PendingComputations {
  private readonly pending = new Map<string, Pending>()
  private readonly now: () => number
  private readonly joinWindowMs: number

  constructor(options: PendingComputationsOptions = {}) {
    this.now = options.now ?? Date.now
    this.joinWindowMs = options.joinWindowMs ?? PENDING_JOIN_WINDOW_MS
  }

  run<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const now = this.now()
    const current = this.pending.get(key)
    if (current && now - current.startedAt < this.joinWindowMs) {
      return current.promise.then() as Promise<T>
    }

    const entry: Pending = { promise: new Promise<T>((resolve) => resolve(compute())), startedAt: now }
    this.pending.set(key, entry)
    const settle = () => {
      if (this.pending.get(key) === entry) this.pending.delete(key)
    }
    entry.promise.then(settle, settle)
    // A promise per caller, so a rejection nobody awaits is still reported as unhandled.
    return entry.promise.then() as Promise<T>
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

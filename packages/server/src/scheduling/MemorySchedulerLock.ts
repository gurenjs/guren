import type { SchedulerLock } from './types'

/**
 * Single-process `SchedulerLock`: one server, or tests. Two processes each
 * holding their own instance never see each other's keys, so a multi-server
 * deploy needs `RedisSchedulerLock` or another shared store.
 */
export class MemorySchedulerLock implements SchedulerLock {
  private readonly held = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  async acquire(key: string, ttlSeconds: number): Promise<boolean> {
    const now = this.now()
    // Keys are per task per minute and never released on a completed run, so
    // without this sweep the map grows for the life of the process.
    this.sweep(now)

    const expiresAt = this.held.get(key)
    if (expiresAt !== undefined && expiresAt > now) {
      return false
    }
    this.held.set(key, now + ttlSeconds * 1000)
    return true
  }

  async release(key: string): Promise<void> {
    this.held.delete(key)
  }

  private sweep(now: number): void {
    for (const [key, expiresAt] of this.held) {
      if (expiresAt <= now) this.held.delete(key)
    }
  }
}

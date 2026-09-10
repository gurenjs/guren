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
    const expiresAt = this.held.get(key)
    if (expiresAt !== undefined && expiresAt > this.now()) {
      return false
    }
    this.held.set(key, this.now() + ttlSeconds * 1000)
    return true
  }

  async release(key: string): Promise<void> {
    this.held.delete(key)
  }
}

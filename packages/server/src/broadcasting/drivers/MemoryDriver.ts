import type {
  BroadcastEvent,
  PresenceBroadcastDriver,
  PresenceMember,
} from '../types'

/**
 * Memory broadcast driver options.
 */
export interface MemoryDriverOptions {
  /**
   * How many published events `getPublishedEvents()` keeps, oldest dropped
   * first. `0` turns recording off.
   *
   * The record exists so tests can assert on what was published, but the
   * driver also serves single-server deployments, where an unbounded record
   * is a leak the size of the app's traffic.
   *
   * @default 1000
   */
  maxPublishedEvents?: number
}

/**
 * Memory broadcast driver.
 *
 * Stores all subscriptions and presence data in memory.
 * Useful for testing and single-server deployments.
 *
 * @example
 * ```typescript
 * const driver = new MemoryDriver()
 *
 * // Subscribe to a channel
 * const unsubscribe = driver.subscribe('notifications', (event) => {
 *   console.log('Received:', event)
 * })
 *
 * // Publish an event
 * await driver.publish('notifications', 'NewMessage', { content: 'Hello!' })
 *
 * // Unsubscribe
 * unsubscribe()
 * ```
 */
export class MemoryDriver implements PresenceBroadcastDriver {
  /**
   * Channel subscribers.
   */
  protected subscribers: Map<
    string,
    Set<(event: BroadcastEvent) => void>
  > = new Map()

  /**
   * Presence channel members.
   */
  protected presenceMembers: Map<
    string,
    Map<string | number, PresenceMember>
  > = new Map()

  /**
   * Published events (for testing), capped at `maxPublishedEvents`.
   */
  protected publishedEvents: BroadcastEvent[] = []

  protected maxPublishedEvents: number

  constructor(options: MemoryDriverOptions = {}) {
    this.maxPublishedEvents = Math.max(0, Math.floor(options.maxPublishedEvents ?? 1000))
  }

  /**
   * Publish an event to a channel.
   */
  async publish(channel: string, event: string, data: unknown): Promise<void> {
    const broadcastEvent: BroadcastEvent = {
      channel,
      event,
      data,
      timestamp: new Date(),
    }

    this.recordPublishedEvent(broadcastEvent)

    // Notify subscribers
    const callbacks = this.subscribers.get(channel)
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(broadcastEvent)
        } catch (error) {
          console.error(`Error in broadcast subscriber:`, error)
        }
      }
    }
  }

  protected recordPublishedEvent(event: BroadcastEvent): void {
    if (this.maxPublishedEvents === 0) return

    this.publishedEvents.push(event)
    if (this.publishedEvents.length > this.maxPublishedEvents) {
      this.publishedEvents.splice(0, this.publishedEvents.length - this.maxPublishedEvents)
    }
  }

  /**
   * Subscribe to a channel.
   */
  subscribe(
    channel: string,
    callback: (event: BroadcastEvent) => void
  ): () => void {
    let callbacks = this.subscribers.get(channel)
    if (!callbacks) {
      callbacks = new Set()
      this.subscribers.set(channel, callbacks)
    }

    callbacks.add(callback)

    // Return unsubscribe function
    return () => {
      this.unsubscribe(channel, callback)
    }
  }

  /**
   * Unsubscribe from a channel.
   */
  unsubscribe(
    channel: string,
    callback: (event: BroadcastEvent) => void
  ): void {
    const callbacks = this.subscribers.get(channel)
    if (callbacks) {
      callbacks.delete(callback)
      if (callbacks.size === 0) {
        this.subscribers.delete(channel)
      }
    }
  }

  /**
   * Get members of a presence channel.
   */
  getMembers(channel: string): PresenceMember[] {
    const members = this.presenceMembers.get(channel)
    return members ? Array.from(members.values()) : []
  }

  /**
   * Add a member to a presence channel.
   */
  addMember(channel: string, member: PresenceMember): void {
    let members = this.presenceMembers.get(channel)
    if (!members) {
      members = new Map()
      this.presenceMembers.set(channel, members)
    }
    members.set(member.id, member)
  }

  /**
   * Remove a member from a presence channel.
   */
  removeMember(channel: string, memberId: string | number): void {
    const members = this.presenceMembers.get(channel)
    if (members) {
      members.delete(memberId)
      if (members.size === 0) {
        this.presenceMembers.delete(channel)
      }
    }
  }

  /**
   * Check if a channel has subscribers.
   */
  hasSubscribers(channel: string): boolean {
    const callbacks = this.subscribers.get(channel)
    return callbacks !== undefined && callbacks.size > 0
  }

  /**
   * Get subscriber count for a channel.
   */
  getSubscriberCount(channel: string): number {
    const callbacks = this.subscribers.get(channel)
    return callbacks ? callbacks.size : 0
  }

  /**
   * Get all channels with subscribers.
   */
  getChannels(): string[] {
    return Array.from(this.subscribers.keys())
  }

  /**
   * Get all presence channels.
   */
  getPresenceChannels(): string[] {
    return Array.from(this.presenceMembers.keys())
  }

  /**
   * Get recorded published events (for testing) — at most the newest
   * `maxPublishedEvents`.
   */
  getPublishedEvents(): BroadcastEvent[] {
    return [...this.publishedEvents]
  }

  /**
   * Get published events for a specific channel.
   */
  getPublishedEventsFor(channel: string): BroadcastEvent[] {
    return this.publishedEvents.filter((e) => e.channel === channel)
  }

  /**
   * Clear all data (for testing).
   */
  clear(): void {
    this.subscribers.clear()
    this.presenceMembers.clear()
    this.publishedEvents = []
  }

  /**
   * Clear published events only.
   */
  clearPublishedEvents(): void {
    this.publishedEvents = []
  }
}

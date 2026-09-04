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
   * first; `0` turns recording off. The record is for tests, but the driver
   * also serves single-server deployments, where an unbounded one is a leak.
   * @default 1000
   */
  maxPublishedEvents?: number
}

/**
 * Keeps subscriptions and presence data in memory — for testing and
 * single-server deployments.
 */
export class MemoryDriver implements PresenceBroadcastDriver {
  protected subscribers: Map<
    string,
    Set<(event: BroadcastEvent) => void>
  > = new Map()

  protected presenceMembers: Map<
    string,
    Map<string | number, PresenceMember>
  > = new Map()

  /** Kept for testing only, capped at `maxPublishedEvents`. */
  protected publishedEvents: BroadcastEvent[] = []

  protected maxPublishedEvents: number

  constructor(options: MemoryDriverOptions = {}) {
    this.maxPublishedEvents = Math.max(0, Math.floor(options.maxPublishedEvents ?? 1000))
  }

  async publish(channel: string, event: string, data: unknown): Promise<void> {
    const broadcastEvent: BroadcastEvent = {
      channel,
      event,
      data,
      timestamp: new Date(),
    }

    this.recordPublishedEvent(broadcastEvent)

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

    return () => {
      this.unsubscribe(channel, callback)
    }
  }

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

  getMembers(channel: string): PresenceMember[] {
    const members = this.presenceMembers.get(channel)
    return members ? Array.from(members.values()) : []
  }

  addMember(channel: string, member: PresenceMember): void {
    let members = this.presenceMembers.get(channel)
    if (!members) {
      members = new Map()
      this.presenceMembers.set(channel, members)
    }
    members.set(member.id, member)
  }

  removeMember(channel: string, memberId: string | number): void {
    const members = this.presenceMembers.get(channel)
    if (members) {
      members.delete(memberId)
      if (members.size === 0) {
        this.presenceMembers.delete(channel)
      }
    }
  }

  hasSubscribers(channel: string): boolean {
    const callbacks = this.subscribers.get(channel)
    return callbacks !== undefined && callbacks.size > 0
  }

  getSubscriberCount(channel: string): number {
    const callbacks = this.subscribers.get(channel)
    return callbacks ? callbacks.size : 0
  }

  getChannels(): string[] {
    return Array.from(this.subscribers.keys())
  }

  getPresenceChannels(): string[] {
    return Array.from(this.presenceMembers.keys())
  }

  /** The newest `maxPublishedEvents` at most. */
  getPublishedEvents(): BroadcastEvent[] {
    return [...this.publishedEvents]
  }

  getPublishedEventsFor(channel: string): BroadcastEvent[] {
    return this.publishedEvents.filter((e) => e.channel === channel)
  }

  clear(): void {
    this.subscribers.clear()
    this.presenceMembers.clear()
    this.publishedEvents = []
  }

  clearPublishedEvents(): void {
    this.publishedEvents = []
  }
}

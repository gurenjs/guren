import type {
  BroadcastEvent,
  PresenceBroadcastDriver,
  PresenceMember,
} from '../types'

/** Compatible with ioredis and similar clients. */
export interface RedisClient {
  publish(channel: string, message: string): Promise<number>
  subscribe(channel: string): Promise<void>
  unsubscribe(channel: string): Promise<void>
  on(event: 'message', callback: (channel: string, message: string) => void): void
  hset(key: string, field: string, value: string): Promise<number>
  hdel(key: string, field: string): Promise<number>
  hgetall(key: string): Promise<Record<string, string>>
  duplicate(): RedisClient
}

/** Uses Redis pub/sub, for multi-server deployments. */
export class RedisDriver implements PresenceBroadcastDriver {
  protected publisher: RedisClient

  protected subscriber: RedisClient

  protected subscribers: Map<
    string,
    Set<(event: BroadcastEvent) => void>
  > = new Map()

  protected localPresence: Map<
    string,
    Map<string | number, PresenceMember>
  > = new Map()

  protected presencePrefix: string = 'broadcasting:presence:'

  constructor(
    redis: RedisClient,
    options: RedisDriverOptions = {}
  ) {
    this.publisher = redis
    this.subscriber = redis.duplicate()

    if (options.presencePrefix) {
      this.presencePrefix = options.presencePrefix
    }

    this.setupSubscriber()
  }

  protected setupSubscriber(): void {
    this.subscriber.on('message', (channel, message) => {
      try {
        const event = JSON.parse(message) as BroadcastEvent
        event.timestamp = new Date(event.timestamp)

        const callbacks = this.subscribers.get(channel)
        if (callbacks) {
          for (const callback of callbacks) {
            try {
              callback(event)
            } catch (error) {
              console.error(`Error in broadcast subscriber:`, error)
            }
          }
        }
      } catch (error) {
        console.error(`Error parsing broadcast message:`, error)
      }
    })
  }

  async publish(channel: string, event: string, data: unknown): Promise<void> {
    const broadcastEvent: BroadcastEvent = {
      channel,
      event,
      data,
      timestamp: new Date(),
    }

    await this.publisher.publish(channel, JSON.stringify(broadcastEvent))
  }

  subscribe(
    channel: string,
    callback: (event: BroadcastEvent) => void
  ): () => void {
    let callbacks = this.subscribers.get(channel)
    const isNew = !callbacks

    if (!callbacks) {
      callbacks = new Set()
      this.subscribers.set(channel, callbacks)
    }

    callbacks.add(callback)

    if (isNew) {
      this.subscriber.subscribe(channel).catch((error) => {
        console.error(`Error subscribing to Redis channel:`, error)
      })
    }

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
        this.subscriber.unsubscribe(channel).catch((error) => {
          console.error(`Error unsubscribing from Redis channel:`, error)
        })
      }
    }
  }

  getMembers(channel: string): PresenceMember[] {
    // Local cache only, so possibly stale; getMembersAsync reads Redis.
    const members = this.localPresence.get(channel)
    return members ? Array.from(members.values()) : []
  }

  async getMembersAsync(channel: string): Promise<PresenceMember[]> {
    const key = `${this.presencePrefix}${channel}`
    const data = await this.publisher.hgetall(key)

    const members: PresenceMember[] = []
    for (const [_, value] of Object.entries(data)) {
      try {
        members.push(JSON.parse(value))
      } catch {
        // Skip invalid entries
      }
    }

    const localMembers = new Map<string | number, PresenceMember>()
    for (const member of members) {
      localMembers.set(member.id, member)
    }
    this.localPresence.set(channel, localMembers)

    return members
  }

  addMember(channel: string, member: PresenceMember): void {
    let members = this.localPresence.get(channel)
    if (!members) {
      members = new Map()
      this.localPresence.set(channel, members)
    }
    members.set(member.id, member)

    // Fire and forget.
    const key = `${this.presencePrefix}${channel}`
    this.publisher
      .hset(key, String(member.id), JSON.stringify(member))
      .catch((error) => {
        console.error(`Error adding presence member to Redis:`, error)
      })
  }

  removeMember(channel: string, memberId: string | number): void {
    const members = this.localPresence.get(channel)
    if (members) {
      members.delete(memberId)
      if (members.size === 0) {
        this.localPresence.delete(channel)
      }
    }

    // Fire and forget.
    const key = `${this.presencePrefix}${channel}`
    this.publisher.hdel(key, String(memberId)).catch((error) => {
      console.error(`Error removing presence member from Redis:`, error)
    })
  }

  hasSubscribers(channel: string): boolean {
    const callbacks = this.subscribers.get(channel)
    return callbacks !== undefined && callbacks.size > 0
  }

  getSubscriberCount(channel: string): number {
    const callbacks = this.subscribers.get(channel)
    return callbacks ? callbacks.size : 0
  }
}

export interface RedisDriverOptions {
  /** Prefix for presence keys. */
  presencePrefix?: string
}

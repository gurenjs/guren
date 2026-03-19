import type { BroadcastDriver } from '../types'

/**
 * Base broadcast channel.
 *
 * @example
 * ```typescript
 * const channel = new Channel('notifications', driver)
 * await channel.broadcast('NewMessage', { content: 'Hello!' })
 * ```
 */
export class Channel {
  constructor(
    public readonly name: string,
    protected driver: BroadcastDriver
  ) {}

  /**
   * Broadcast an event to this channel.
   */
  async broadcast(event: string, data: unknown): Promise<void> {
    await this.driver.publish(this.name, event, data)
  }

  /**
   * Subscribe to events on this channel.
   * Returns an unsubscribe function.
   */
  subscribe(
    callback: (event: string, data: unknown) => void
  ): () => void {
    return this.driver.subscribe(this.name, (e) => {
      callback(e.event, e.data)
    })
  }

  /**
   * Get the full channel name for broadcasting.
   */
  getChannelName(): string {
    return this.name
  }
}

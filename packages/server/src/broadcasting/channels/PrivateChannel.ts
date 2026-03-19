import { Channel } from './Channel'
import type { BroadcastDriver } from '../types'

/**
 * Private broadcast channel.
 *
 * Requires authentication to subscribe.
 *
 * @example
 * ```typescript
 * const channel = new PrivateChannel('orders.123', driver)
 * await channel.broadcast('OrderUpdated', { status: 'shipped' })
 * ```
 */
export class PrivateChannel extends Channel {
  /**
   * Channel name prefix.
   */
  static readonly PREFIX = 'private-'

  constructor(name: string, driver: BroadcastDriver) {
    // Ensure private prefix
    const channelName = name.startsWith(PrivateChannel.PREFIX)
      ? name
      : `${PrivateChannel.PREFIX}${name}`
    super(channelName, driver)
  }

  /**
   * Get the channel name without the private prefix.
   */
  getBaseName(): string {
    return this.name.startsWith(PrivateChannel.PREFIX)
      ? this.name.slice(PrivateChannel.PREFIX.length)
      : this.name
  }

  /**
   * Check if a channel name is a private channel.
   */
  static isPrivateChannel(name: string): boolean {
    return name.startsWith(PrivateChannel.PREFIX)
  }

  /**
   * Normalize a channel name to include the private prefix.
   */
  static normalize(name: string): string {
    return name.startsWith(PrivateChannel.PREFIX)
      ? name
      : `${PrivateChannel.PREFIX}${name}`
  }
}

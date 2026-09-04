import { Channel } from './Channel'
import type { BroadcastDriver } from '../types'

/** Broadcast channel that requires authentication to subscribe. */
export class PrivateChannel extends Channel {
  static readonly PREFIX = 'private-'

  constructor(name: string, driver: BroadcastDriver) {
    const channelName = name.startsWith(PrivateChannel.PREFIX)
      ? name
      : `${PrivateChannel.PREFIX}${name}`
    super(channelName, driver)
  }

  getBaseName(): string {
    return this.name.startsWith(PrivateChannel.PREFIX)
      ? this.name.slice(PrivateChannel.PREFIX.length)
      : this.name
  }

  static isPrivateChannel(name: string): boolean {
    return name.startsWith(PrivateChannel.PREFIX)
  }

  static normalize(name: string): string {
    return name.startsWith(PrivateChannel.PREFIX)
      ? name
      : `${PrivateChannel.PREFIX}${name}`
  }
}

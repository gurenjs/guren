import { Channel } from './Channel'
import type { BroadcastDriver, PresenceBroadcastDriver, PresenceMember } from '../types'

/**
 * Presence broadcast channel.
 *
 * Tracks members who have joined the channel.
 *
 * @example
 * ```typescript
 * const channel = new PresenceChannel('chat.1', driver)
 *
 * // Join channel
 * await channel.join({ id: 1, info: { name: 'John' } })
 *
 * // Get members
 * const members = channel.members()
 *
 * // Leave channel
 * await channel.leave(1)
 *
 * // Broadcast
 * await channel.broadcast('UserTyping', { userId: 1 })
 * ```
 */
export class PresenceChannel extends Channel {
  /**
   * Channel name prefix.
   */
  static readonly PREFIX = 'presence-'

  protected presenceDriver: PresenceBroadcastDriver

  constructor(name: string, driver: BroadcastDriver) {
    // Ensure presence prefix
    const channelName = name.startsWith(PresenceChannel.PREFIX)
      ? name
      : `${PresenceChannel.PREFIX}${name}`
    super(channelName, driver)

    // Check if driver supports presence
    if (this.isPresenceDriver(driver)) {
      this.presenceDriver = driver
    } else {
      throw new Error(
        `Driver does not support presence channels. ` +
          `Ensure the driver implements PresenceBroadcastDriver interface.`
      )
    }
  }

  /**
   * Check if a driver supports presence.
   */
  protected isPresenceDriver(
    driver: BroadcastDriver
  ): driver is PresenceBroadcastDriver {
    return (
      'getMembers' in driver &&
      'addMember' in driver &&
      'removeMember' in driver
    )
  }

  /**
   * Get members in this channel.
   */
  members(): PresenceMember[] {
    return this.presenceDriver.getMembers(this.name)
  }

  /**
   * Join the channel.
   */
  async join(member: PresenceMember): Promise<void> {
    this.presenceDriver.addMember(this.name, member)

    // Broadcast member joined event
    await this.broadcast('presence:joining', {
      member,
    })
  }

  /**
   * Leave the channel.
   */
  async leave(memberId: string | number): Promise<void> {
    const members = this.members()
    const member = members.find((m) => m.id === memberId)

    this.presenceDriver.removeMember(this.name, memberId)

    // Broadcast member left event
    if (member) {
      await this.broadcast('presence:leaving', {
        member,
      })
    }
  }

  /**
   * Check if a member is in the channel.
   */
  hasMember(memberId: string | number): boolean {
    return this.members().some((m) => m.id === memberId)
  }

  /**
   * Get member by ID.
   */
  getMember(memberId: string | number): PresenceMember | undefined {
    return this.members().find((m) => m.id === memberId)
  }

  /**
   * Get member count.
   */
  count(): number {
    return this.members().length
  }

  /**
   * Get the channel name without the presence prefix.
   */
  getBaseName(): string {
    return this.name.startsWith(PresenceChannel.PREFIX)
      ? this.name.slice(PresenceChannel.PREFIX.length)
      : this.name
  }

  /**
   * Check if a channel name is a presence channel.
   */
  static isPresenceChannel(name: string): boolean {
    return name.startsWith(PresenceChannel.PREFIX)
  }

  /**
   * Normalize a channel name to include the presence prefix.
   */
  static normalize(name: string): string {
    return name.startsWith(PresenceChannel.PREFIX)
      ? name
      : `${PresenceChannel.PREFIX}${name}`
  }
}

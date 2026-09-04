import { Channel } from './Channel'
import type { BroadcastDriver, PresenceBroadcastDriver, PresenceMember } from '../types'

/** Broadcast channel that tracks the members who have joined it. */
export class PresenceChannel extends Channel {
  static readonly PREFIX = 'presence-'

  protected presenceDriver: PresenceBroadcastDriver

  constructor(name: string, driver: BroadcastDriver) {
    const channelName = name.startsWith(PresenceChannel.PREFIX)
      ? name
      : `${PresenceChannel.PREFIX}${name}`
    super(channelName, driver)

    if (this.isPresenceDriver(driver)) {
      this.presenceDriver = driver
    } else {
      throw new Error(
        `Driver does not support presence channels. ` +
          `Ensure the driver implements PresenceBroadcastDriver interface.`
      )
    }
  }

  protected isPresenceDriver(
    driver: BroadcastDriver
  ): driver is PresenceBroadcastDriver {
    return (
      'getMembers' in driver &&
      'addMember' in driver &&
      'removeMember' in driver
    )
  }

  members(): PresenceMember[] {
    return this.presenceDriver.getMembers(this.name)
  }

  async join(member: PresenceMember): Promise<void> {
    this.presenceDriver.addMember(this.name, member)

    await this.broadcast('presence:joining', {
      member,
    })
  }

  async leave(memberId: string | number): Promise<void> {
    const members = this.members()
    const member = members.find((m) => m.id === memberId)

    this.presenceDriver.removeMember(this.name, memberId)

    if (member) {
      await this.broadcast('presence:leaving', {
        member,
      })
    }
  }

  hasMember(memberId: string | number): boolean {
    return this.members().some((m) => m.id === memberId)
  }

  getMember(memberId: string | number): PresenceMember | undefined {
    return this.members().find((m) => m.id === memberId)
  }

  count(): number {
    return this.members().length
  }

  getBaseName(): string {
    return this.name.startsWith(PresenceChannel.PREFIX)
      ? this.name.slice(PresenceChannel.PREFIX.length)
      : this.name
  }

  static isPresenceChannel(name: string): boolean {
    return name.startsWith(PresenceChannel.PREFIX)
  }

  static normalize(name: string): string {
    return name.startsWith(PresenceChannel.PREFIX)
      ? name
      : `${PresenceChannel.PREFIX}${name}`
  }
}

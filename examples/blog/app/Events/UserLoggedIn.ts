import { Event } from '@guren/core'
import type { UserRecord } from '../Models/User.js'

/**
 * Event fired when a user logs in.
 */
export class UserLoggedIn extends Event {
  constructor(
    public readonly user: UserRecord,
    public readonly ipAddress: string | null = null
  ) {
    super()
  }
}

import { Event } from '@guren/core'

/**
 * Event fired when a new user registers.
 */
export class UserRegistered extends Event {
  constructor(
    public readonly userId: number,
    public readonly email: string,
    public readonly name: string
  ) {
    super()
  }
}

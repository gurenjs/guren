import { Listener } from '@guren/core'
import { UserRegistered } from '../Events/UserRegistered.js'

/**
 * Listener that logs user registration events.
 */
export class LogUserRegistration extends Listener<UserRegistered> {
  static override event = UserRegistered
  static override priority = 10

  async handle(event: UserRegistered): Promise<void> {
    console.log(
      `[Auth] User registered: "${event.name}" (${event.email}) at ${event.timestamp.toISOString()}`
    )
  }
}

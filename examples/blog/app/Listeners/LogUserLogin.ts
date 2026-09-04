import { Listener } from '@guren/core'
import { UserLoggedIn } from '../Events/UserLoggedIn.js'

export class LogUserLogin extends Listener<UserLoggedIn> {
  static override event = UserLoggedIn
  static override priority = 10

  async handle(event: UserLoggedIn): Promise<void> {
    const { user } = event
    console.log(
      `[Auth] User "${user.name}" (${user.email}) logged in at ${event.timestamp.toISOString()}` +
        (event.ipAddress ? ` from ${event.ipAddress}` : '')
    )
  }
}

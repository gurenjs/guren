import { Job } from '@guren/core'
import { User } from '../Models/User.js'
import { sendRegistrationMail } from '../Mail/RegistrationMail.js'

interface SendRegistrationEmailPayload {
  userId: number
}

export class SendRegistrationEmailJob extends Job<SendRegistrationEmailPayload> {
  static override queue = 'emails'
  static override maxAttempts = 3
  static override backoff: 'exponential' = 'exponential'

  async handle(payload: SendRegistrationEmailPayload): Promise<void> {
    const user = await User.find(payload.userId)
    if (!user) {
      console.log(`[Job] User ${payload.userId} not found, skipping registration email`)
      return
    }

    await sendRegistrationMail(this.make('mail'), { email: user.email, name: user.name })
    console.log(`[Job] Registration email sent to ${user.email}`)
  }

  async failed(payload: SendRegistrationEmailPayload, error: Error): Promise<void> {
    console.error(
      `[Job] Failed to send registration email for user ${payload.userId}:`,
      error.message
    )
  }
}

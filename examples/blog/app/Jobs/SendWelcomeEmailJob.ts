import { Job } from '@guren/server'
import { User } from '../Models/User.js'
import { sendWelcomeMail } from '../Mail/WelcomeMail.js'

interface SendWelcomeEmailPayload {
  userId: number
}

/**
 * Job that sends a welcome email to a newly registered user.
 * This runs in the background to avoid blocking the registration flow.
 */
export class SendWelcomeEmailJob extends Job<SendWelcomeEmailPayload> {
  static override queue = 'emails'
  static override maxAttempts = 3
  static override backoff: 'exponential' = 'exponential'

  async handle(payload: SendWelcomeEmailPayload): Promise<void> {
    const user = await User.find(payload.userId)
    if (!user) {
      console.log(`[Job] User ${payload.userId} not found, skipping welcome email`)
      return
    }

    await sendWelcomeMail(user)
    console.log(`[Job] Welcome email sent to ${user.email}`)
  }

  async failed(payload: SendWelcomeEmailPayload, error: Error): Promise<void> {
    console.error(
      `[Job] Failed to send welcome email for user ${payload.userId}:`,
      error.message
    )
  }
}

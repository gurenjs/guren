import { Job } from '@guren/core'
import { sendPasswordResetMail } from '../Mail/PasswordResetMail.js'

interface SendPasswordResetEmailPayload {
  email: string
  resetUrl: string
}

/**
 * Job that sends the password-reset email. Dispatched (never awaited)
 * regardless of whether the account exists, so ForgotPasswordController's
 * response time doesn't leak which emails are registered.
 */
export class SendPasswordResetEmailJob extends Job<SendPasswordResetEmailPayload> {
  static override queue = 'emails'
  static override maxAttempts = 3
  static override backoff: 'exponential' = 'exponential'

  async handle(payload: SendPasswordResetEmailPayload): Promise<void> {
    await sendPasswordResetMail(this.make('mail'), payload.email, payload.resetUrl)
    console.log(`[Job] Password reset email sent to ${payload.email}`)
  }

  async failed(payload: SendPasswordResetEmailPayload, error: Error): Promise<void> {
    console.error(
      `[Job] Failed to send password reset email to ${payload.email}:`,
      error.message
    )
  }
}

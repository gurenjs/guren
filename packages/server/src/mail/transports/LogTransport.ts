import type { MailMessage, MailTransport, SendResult } from '../types'

export interface LogTransportOptions {
  /** @default console.log */
  logger?: (message: string) => void
}

/**
 * Log mail transport: writes each email to the log instead of sending it.
 * This is the development default (`MAIL_MAILER=log`) — every send succeeds
 * and the full message is visible in the server output.
 */
export class LogTransport implements MailTransport {
  readonly name = 'log'
  private readonly logger: (message: string) => void

  constructor(options: LogTransportOptions = {}) {
    this.logger = options.logger ?? console.log
  }

  async send(message: MailMessage): Promise<SendResult> {
    const to = message.to.map((address) => address.email).join(', ')
    const from = message.from ? message.from.email : '(default sender)'
    const body = message.text ?? message.html ?? ''

    this.logger(
      [
        '[mail] ------------------------------------------------------------',
        `[mail] To: ${to}`,
        `[mail] From: ${from}`,
        `[mail] Subject: ${message.subject}`,
        `[mail] ${body.split('\n').join('\n[mail] ')}`,
        '[mail] ------------------------------------------------------------',
      ].join('\n'),
    )

    return {
      success: true,
      messageId: `log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      response: 'Message written to log',
    }
  }
}

import type { MailMessage, MailTransport, SendResult } from '../types'

export interface LogTransportOptions {
  /** @default console.log */
  logger?: (message: string) => void
}

// The parameters the framework writes credentials under: `buildTokenUrl()`
// (password reset, email verification) and `signUrl()`. A `;` before the name
// is the end of `&amp;` in an html body; dots sit only between runs, so a
// sentence's closing period stays.
const CREDENTIAL_PARAM = /([?&;])(token|signature)=[\w%*+~-]+(?:\.[\w%*+~-]+)*/g

function redactCredentials(body: string): string {
  return body.replace(CREDENTIAL_PARAM, (_match, separator: string, name: string) => `${separator}${name}=[redacted]`)
}

/**
 * Log mail transport: writes each email to the log instead of sending it.
 * This is the development default (`MAIL_MAILER=log`) — every send succeeds
 * and the full message is visible in the server output. Under production the
 * values of `token` and `signature` parameters are redacted: such a link works
 * for whoever reads the log.
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
    const raw = message.text ?? message.html ?? ''
    // Read per send, with no optional chain, so the deploy plugins' `--define` settles it.
    const production = typeof process !== 'undefined' && process.env.NODE_ENV === 'production'
    const body = production ? redactCredentials(raw) : raw

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

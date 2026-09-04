import type { MailTransport, MailMessage, SendResult, ResendTransportOptions } from '../types'

/** Resend API response types. */
interface ResendSuccessResponse {
  id: string
}

interface ResendErrorResponse {
  statusCode: number
  message: string
  name: string
}

/** Resend mail transport. */
export class ResendTransport implements MailTransport {
  readonly name = 'resend'
  private readonly apiKey: string
  private readonly baseUrl = 'https://api.resend.com'

  constructor(options: ResendTransportOptions) {
    this.apiKey = options.apiKey
  }

  private formatAddress(addr: { email: string; name?: string }): string {
    if (addr.name) {
      return `${addr.name} <${addr.email}>`
    }
    return addr.email
  }

  async send(message: MailMessage): Promise<SendResult> {
    try {
      const payload: Record<string, unknown> = {
        from: message.from ? this.formatAddress(message.from) : undefined,
        to: message.to.map((a) => this.formatAddress(a)),
        subject: message.subject,
      }

      if (message.cc?.length) {
        payload.cc = message.cc.map((a) => this.formatAddress(a))
      }

      if (message.bcc?.length) {
        payload.bcc = message.bcc.map((a) => this.formatAddress(a))
      }

      if (message.replyTo) {
        payload.reply_to = this.formatAddress(message.replyTo)
      }

      if (message.text) {
        payload.text = message.text
      }

      if (message.html) {
        payload.html = message.html
      }

      if (message.attachments?.length) {
        payload.attachments = message.attachments.map((a) => ({
          filename: a.filename,
          content: a.content instanceof Buffer ? a.content.toString('base64') : a.content,
          content_type: a.contentType,
        }))
      }

      if (message.headers) {
        payload.headers = message.headers
      }

      const response = await fetch(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorData = (await response.json()) as ResendErrorResponse
        return {
          success: false,
          error: errorData.message || `HTTP ${response.status}`,
        }
      }

      const data = (await response.json()) as ResendSuccessResponse

      return {
        success: true,
        messageId: data.id,
        response: `Message sent with ID: ${data.id}`,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

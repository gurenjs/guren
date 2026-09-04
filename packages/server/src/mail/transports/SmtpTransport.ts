import nodemailer from 'nodemailer'
import type { MailTransport, MailMessage, SendResult, SmtpTransportOptions } from '../types'

/** Format an email address for nodemailer. */
function formatAddress(addr: { email: string; name?: string }): string {
  if (addr.name) {
    return `"${addr.name}" <${addr.email}>`
  }
  return addr.email
}

/** SMTP mail transport using Nodemailer. */
export class SmtpTransport implements MailTransport {
  readonly name = 'smtp'
  // `any` avoids nodemailer type gymnastics.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly transporter: any

  constructor(options: SmtpTransportOptions) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port ?? 587,
      secure: options.secure ?? false,
      auth: options.auth,
      pool: options.pool ?? true,
      maxConnections: options.maxConnections ?? 5,
    } as nodemailer.TransportOptions)
  }

  async send(message: MailMessage): Promise<SendResult> {
    try {
      const mailOptions = {
        from: message.from ? formatAddress(message.from) : undefined,
        to: message.to.map(formatAddress).join(', '),
        cc: message.cc?.map(formatAddress).join(', '),
        bcc: message.bcc?.map(formatAddress).join(', '),
        replyTo: message.replyTo ? formatAddress(message.replyTo) : undefined,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: message.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          path: a.path,
          contentType: a.contentType,
          cid: a.cid,
        })),
        headers: message.headers,
      }

      const result = await this.transporter.sendMail(mailOptions)

      return {
        success: true,
        messageId: result.messageId,
        response: result.response,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify()
      return true
    } catch {
      return false
    }
  }

  close(): void {
    this.transporter.close()
  }
}

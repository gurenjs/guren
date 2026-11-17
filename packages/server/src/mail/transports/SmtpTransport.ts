import nodemailer from 'nodemailer'
import { isLoopbackAddress } from '../../http/middleware/loopback-guard'
import type { MailTransport, MailMessage, SendResult, SmtpTransportOptions } from '../types'

/**
 * Whether a stripped STARTTLS would put credentials on the network in cleartext. A host on this
 * machine is left out, since a local mail catcher speaks no TLS; `'localhost'` is nodemailer's
 * own fallback for an empty host.
 */
function sendsCredentialsOffHost(options: SmtpTransportOptions): boolean {
  if (options.secure || !(options.auth?.user || options.auth?.pass)) return false
  const host = (options.host || 'localhost').toLowerCase()
  return host !== 'localhost' && !isLoopbackAddress(canonicalAddress(host))
}

/**
 * An IP literal as the WHATWG URL parser writes it (`0:0:0:0:0:0:0:1` as `::1`, `127.1` as
 * `127.0.0.1`), with an IPv4-mapped IPv6 address back in dotted form; any other host unchanged.
 */
function canonicalAddress(host: string): string {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  let hostname: string
  try {
    hostname = new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}/`).hostname
  } catch {
    return host
  }
  if (!hostname.startsWith('[')) return hostname
  const address = hostname.slice(1, -1)
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address)
  if (!mapped) return address
  const high = Number.parseInt(mapped[1]!, 16)
  const low = Number.parseInt(mapped[2]!, 16)
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

/** Format an email address for nodemailer. */
function formatAddress(addr: { email: string; name?: string }): string {
  if (addr.name) {
    // nodemailer re-reads the joined header with addressparser, where an unescaped `"` or `\` ends
    // the quoted name and the rest reads as more recipients (CWE-140). A name that is already one
    // complete quoted-string, as parseMailAddress('"Jane" <j@x.test>') leaves it, is not quoted twice.
    const name = String(addr.name)
    const quoted = /^"(?:[^"\\]|\\[\s\S])*"$/.test(name) ? name : `"${name.replace(/[\\"]/g, '\\$&')}"`
    return `${quoted} <${addr.email}>`
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
      requireTLS: options.requireTLS ?? sendsCredentialsOffHost(options),
      tls: options.tls,
      auth: options.auth,
      pool: options.pool ?? true,
      maxConnections: options.maxConnections ?? 5,
    })
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

import type { NotificationChannel, Notifiable } from '../types'
import type { Notification } from '../Notification'
import type { MailManager } from '../../mail/MailManager'
import type { MailAddress } from '../../mail/types'
import { parseMailAddress } from '../../mail/address'

function parseAddress(input?: string | MailAddress): MailAddress | undefined {
  if (!input) {
    return undefined
  }

  return parseMailAddress(input)
}

function parseAddressList(
  input?: string | string[] | MailAddress | MailAddress[]
): MailAddress[] | undefined {
  if (!input) {
    return undefined
  }

  const items = Array.isArray(input) ? input : [input]
  const parsed = items
    .map((item) => parseAddress(item))
    .filter((item): item is MailAddress => Boolean(item))

  return parsed.length > 0 ? parsed : undefined
}

/**
 * Mail notification channel.
 *
 * Sends notifications via email using the MailManager.
 *
 * @example
 * ```typescript
 * const mailChannel = new MailChannel(mailManager)
 * notifications.registerChannel('mail', mailChannel)
 *
 * // In notification class:
 * toMail(notifiable: Notifiable): NotificationMailMessage {
 *   return {
 *     subject: 'Order Shipped',
 *     html: '<p>Your order has shipped!</p>',
 *   }
 * }
 * ```
 */
export class MailChannel implements NotificationChannel {
  readonly name = 'mail'

  constructor(
    private mailManager: MailManager,
    private options: MailChannelOptions = {}
  ) {}

  /**
   * Send the notification via mail.
   */
  async send(notifiable: Notifiable, notification: Notification): Promise<void> {
    // Get mail message from notification
    const message = notification.toMail?.(notifiable)
    if (!message) {
      return
    }

    // Get recipient email
    const to = notifiable.routeNotificationFor('mail')
    if (!to) {
      return
    }

    // Get transport
    const transport = this.mailManager.transport(this.options.transport)

    // Build and send email
    const toAddresses = parseAddressList(to)
    if (!toAddresses || toAddresses.length === 0) {
      return
    }

    await transport.send({
      to: toAddresses,
      from: parseAddress(message.from ?? this.options.from),
      replyTo: parseAddress(message.replyTo),
      cc: parseAddressList(message.cc),
      bcc: parseAddressList(message.bcc),
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        path: a.path,
        contentType: a.contentType,
      })),
    })
  }
}

/**
 * Mail channel options.
 */
export interface MailChannelOptions {
  /**
   * Default from address.
   */
  from?: string

  /**
   * Transport name to use.
   */
  transport?: string
}

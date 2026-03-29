import type { NotificationChannel, Notifiable, SlackMessage } from '../types'
import type { Notification } from '../Notification'

/**
 * Slack notification channel.
 *
 * Sends notifications to Slack via incoming webhooks.
 *
 * @example
 * ```typescript
 * const slackChannel = new SlackChannel('https://hooks.slack.com/services/...')
 * notifications.registerChannel('slack', slackChannel)
 *
 * // In notification class:
 * toSlack(notifiable: Notifiable): SlackMessage {
 *   return {
 *     text: `Order #${this.order.id} has been shipped!`,
 *     blocks: [
 *       {
 *         type: 'section',
 *         text: {
 *           type: 'mrkdwn',
 *           text: `*Order Shipped*\nOrder #${this.order.id} is on its way!`,
 *         },
 *       },
 *     ],
 *   }
 * }
 * ```
 */
export class SlackChannel implements NotificationChannel {
  readonly name = 'slack'

  constructor(
    private webhookUrl: string,
    private options: SlackChannelOptions = {}
  ) {}

  /**
   * Send the notification to Slack.
   */
  async send(notifiable: Notifiable, notification: Notification): Promise<void> {
    // Get Slack message from notification
    const message = notification.toSlack?.(notifiable)
    if (!message) {
      return
    }

    // Get webhook URL (notifiable-specific or default)
    const webhookUrl =
      notifiable.routeNotificationFor('slack') ?? this.webhookUrl
    if (!webhookUrl) {
      return
    }

    // Build payload
    const payload = this.buildPayload(message)

    // Send to Slack
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Slack webhook failed: ${response.status} ${text}`)
    }
  }

  /**
   * Build the Slack webhook payload.
   */
  protected buildPayload(message: SlackMessage): SlackWebhookPayload {
    const payload: SlackWebhookPayload = {}

    // Text (required if no blocks)
    if (message.text) {
      payload.text = message.text
    }

    // Blocks
    if (message.blocks && message.blocks.length > 0) {
      payload.blocks = message.blocks
    }

    // Attachments
    if (message.attachments && message.attachments.length > 0) {
      payload.attachments = message.attachments
    }

    // Channel override
    if (message.channel) {
      payload.channel = message.channel
    }

    // Username override
    if (message.username ?? this.options.username) {
      payload.username = message.username ?? this.options.username
    }

    // Icon emoji override
    if (message.icon_emoji ?? this.options.iconEmoji) {
      payload.icon_emoji = message.icon_emoji ?? this.options.iconEmoji
    }

    // Icon URL override
    if (message.icon_url ?? this.options.iconUrl) {
      payload.icon_url = message.icon_url ?? this.options.iconUrl
    }

    return payload
  }
}

/**
 * Slack channel options.
 */
export interface SlackChannelOptions {
  /**
   * Default username for messages.
   */
  username?: string

  /**
   * Default icon emoji for messages.
   */
  iconEmoji?: string

  /**
   * Default icon URL for messages.
   */
  iconUrl?: string
}

/**
 * Slack webhook payload.
 */
interface SlackWebhookPayload {
  text?: string
  blocks?: unknown[]
  attachments?: unknown[]
  channel?: string
  username?: string
  icon_emoji?: string
  icon_url?: string
}

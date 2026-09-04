import type { NotificationChannel, Notifiable, SlackMessage } from '../types'
import type { Notification } from '../Notification'

/** Slack notification channel: sends notifications via incoming webhooks. */
export class SlackChannel implements NotificationChannel {
  readonly name = 'slack'

  constructor(
    private webhookUrl: string,
    private options: SlackChannelOptions = {}
  ) {}

  async send(notifiable: Notifiable, notification: Notification): Promise<void> {
    const message = notification.toSlack?.(notifiable)
    if (!message) {
      return
    }

    const webhookUrl =
      notifiable.routeNotificationFor('slack') ?? this.webhookUrl
    if (!webhookUrl) {
      return
    }

    const payload = this.buildPayload(message)

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

  protected buildPayload(message: SlackMessage): SlackWebhookPayload {
    const payload: SlackWebhookPayload = {}

    // Required unless blocks are present.
    if (message.text) {
      payload.text = message.text
    }

    if (message.blocks && message.blocks.length > 0) {
      payload.blocks = message.blocks
    }

    if (message.attachments && message.attachments.length > 0) {
      payload.attachments = message.attachments
    }

    if (message.channel) {
      payload.channel = message.channel
    }

    if (message.username ?? this.options.username) {
      payload.username = message.username ?? this.options.username
    }

    if (message.icon_emoji ?? this.options.iconEmoji) {
      payload.icon_emoji = message.icon_emoji ?? this.options.iconEmoji
    }

    if (message.icon_url ?? this.options.iconUrl) {
      payload.icon_url = message.icon_url ?? this.options.iconUrl
    }

    return payload
  }
}

/** Slack channel options. */
export interface SlackChannelOptions {
  username?: string

  iconEmoji?: string

  iconUrl?: string
}

/** Slack webhook payload. */
interface SlackWebhookPayload {
  text?: string
  blocks?: unknown[]
  attachments?: unknown[]
  channel?: string
  username?: string
  icon_emoji?: string
  icon_url?: string
}

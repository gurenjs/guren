import type { Notification } from './Notification'

/**
 * Notification channel interface.
 */
export interface NotificationChannel {
  readonly name: string
  send(notifiable: Notifiable, notification: Notification): Promise<void>
}

/**
 * Notifiable entity interface.
 */
export interface Notifiable {
  /**
   * Get the notification routing information for a given channel.
   */
  routeNotificationFor(channel: string): string | null

  /**
   * Database notifications (optional).
   */
  notifications?: DatabaseNotification[]
}

/**
 * Database notification record.
 */
export interface DatabaseNotification {
  id: string
  type: string
  notifiableId: string | number
  notifiableType: string
  data: Record<string, unknown>
  readAt: Date | null
  createdAt: Date
}

/**
 * Mail message for notifications.
 */
export interface NotificationMailMessage {
  subject: string
  html?: string
  text?: string
  from?: string
  replyTo?: string
  cc?: string | string[]
  bcc?: string | string[]
  attachments?: NotificationAttachment[]
}

/**
 * Notification attachment.
 */
export interface NotificationAttachment {
  filename: string
  content?: string | Buffer
  path?: string
  contentType?: string
}

/**
 * Slack message for notifications.
 */
export interface SlackMessage {
  text?: string
  blocks?: SlackBlock[]
  attachments?: SlackAttachment[]
  channel?: string
  username?: string
  icon_emoji?: string
  icon_url?: string
}

/**
 * Slack block.
 */
export interface SlackBlock {
  type: string
  text?: {
    type: string
    text: string
    emoji?: boolean
  }
  elements?: unknown[]
  accessory?: unknown
  fields?: Array<{
    type: string
    text: string
  }>
  [key: string]: unknown
}

/**
 * Slack attachment.
 */
export interface SlackAttachment {
  color?: string
  fallback?: string
  pretext?: string
  author_name?: string
  author_link?: string
  author_icon?: string
  title?: string
  title_link?: string
  text?: string
  fields?: Array<{
    title: string
    value: string
    short?: boolean
  }>
  image_url?: string
  thumb_url?: string
  footer?: string
  footer_icon?: string
  ts?: number
}

/**
 * Notification channel factory.
 */
export interface NotificationChannelFactory {
  (config: Record<string, unknown>): NotificationChannel
}

/**
 * Notification manager options.
 */
export interface NotificationManagerOptions {
  channels?: Record<string, NotificationChannel>
  channelFactories?: Record<string, NotificationChannelFactory>
}

/**
 * Database channel options.
 */
export interface DatabaseChannelOptions {
  /**
   * Callback to store the notification.
   */
  store?: (
    notifiable: Notifiable,
    notification: DatabaseNotification
  ) => Promise<void>
}

/**
 * Sent notification record (for testing).
 */
export interface SentNotification {
  notifiable: Notifiable
  notification: Notification
  channels: string[]
  timestamp: Date
}

/**
 * Notification class type.
 */
export interface NotificationClass<T extends Notification = Notification> {
  new (...args: unknown[]): T
  shouldQueue?: boolean
  queue?: string
  delay?: number
  getQueueConfig?: () => { shouldQueue: boolean; queue?: string; delay?: number }
}

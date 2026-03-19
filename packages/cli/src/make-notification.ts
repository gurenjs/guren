import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const NOTIFICATIONS_DIR = 'app/Notifications'

function notificationTemplate(className: string): string {
  return `/**
 * ${className} notification.
 */
export default class ${className} {
  /**
   * Create a new notification instance.
   */
  constructor(
    // Define your notification data here
    public readonly data: Record<string, unknown> = {},
  ) {}

  /**
   * Get the notification channels.
   */
  via(): string[] {
    return ['mail', 'database']
  }

  /**
   * Get the mail representation of the notification.
   */
  toMail() {
    return {
      subject: '${className.replace(/Notification$/, '')}',
      body: 'Your notification content here.',
    }
  }

  /**
   * Get the database representation of the notification.
   */
  toDatabase() {
    return {
      type: '${className}',
      data: this.data,
    }
  }

  /**
   * Get the array representation of the notification.
   */
  toArray() {
    return {
      ...this.data,
    }
  }
}
`
}

export async function makeNotification(name: string, options: WriterOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: NOTIFICATIONS_DIR,
    suffix: 'Notification',
    template: ({ normalizedName }) => notificationTemplate(normalizedName),
  }, options)
}

import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const NOTIFICATIONS_DIR = 'app/Notifications'

function notificationTemplate(className: string): string {
  return `import { Notification } from '@guren/core'
import type { NotificationMailMessage } from '@guren/core'

export class ${className} extends Notification {
  constructor(
    public readonly data: Record<string, unknown> = {},
  ) {
    super()
  }

  override get type(): string {
    return '${className}'
  }

  via(): string[] {
    return ['mail', 'database']
  }

  override toMail(): NotificationMailMessage {
    return {
      subject: '${className.replace(/Notification$/, '')}',
      text: 'Your notification content here.',
    }
  }

  override toDatabase(): Record<string, unknown> {
    return {
      ...this.data,
    }
  }

  override toArray(): Record<string, unknown> {
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

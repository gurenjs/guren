import { NOTIFICATIONS_DIR } from './discovery'
import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

function notificationTemplate(className: string): string {
  return `import { Notification, type NotificationMailMessage } from '@guren/core'

export class ${className} extends Notification {
  constructor(
    public readonly data: Record<string, unknown> = {},
  ) {
    super()
  }

  // A getter is inherited: without the check a subclass would take this pin and its registry key.
  override get type(): string {
    return this.constructor === ${className} ? '${className}' : this.constructor.name
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

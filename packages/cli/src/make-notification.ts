import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const NOTIFICATIONS_DIR = 'app/Notifications'

function notificationTemplate(className: string): string {
  return `export class ${className} {
  constructor(
    public readonly data: Record<string, unknown> = {},
  ) {}

  via(): string[] {
    return ['mail', 'database']
  }

  toMail() {
    return {
      subject: '${className.replace(/Notification$/, '')}',
      body: 'Your notification content here.',
    }
  }

  toDatabase() {
    return {
      type: '${className}',
      data: this.data,
    }
  }

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

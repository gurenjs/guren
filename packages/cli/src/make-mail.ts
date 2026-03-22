import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const MAIL_DIR = 'app/Mail'

function mailTemplate(className: string): string {
  const subject = className.replace(/Mail$/, '')
  return `import { Mail, type MailManager } from '@guren/core'

/**
 * ${className}
 */
export default class ${className} extends Mail {
  /**
   * Create a new mailable instance.
   */
  constructor(
    manager: MailManager,
    // Define your mail data here
    public readonly data: Record<string, unknown> = {},
  ) {
    super(manager)
  }

  /**
   * Build the message.
   */
  build(): this {
    return this
      .subject('${subject}')
      .text('Replace this body with your real email content.')
  }
}
`
}

export async function makeMail(name: string, options: WriterOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: MAIL_DIR,
    suffix: 'Mail',
    template: ({ normalizedName }) => mailTemplate(normalizedName),
  }, options)
}

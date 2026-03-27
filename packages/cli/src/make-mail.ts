import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const MAIL_DIR = 'app/Mail'

function mailTemplate(className: string): string {
  const subject = className.replace(/Mail$/, '')
  return `import { Mail, type MailManager } from '@guren/core'

export class ${className} extends Mail {
  constructor(
    manager: MailManager,
    public readonly data: Record<string, unknown> = {},
  ) {
    super(manager)
  }

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

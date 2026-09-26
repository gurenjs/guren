import { MAIL_DIR } from './discovery'
import type { ScaffoldFileEntry, WriterOptions } from './utils'
import { scaffoldFileEntry, writeScaffoldFile } from './utils'

/** The mail `make:mail` writes, and `plan:scaffold` under the plan's class name. */
export function buildMailSource(className: string): string {
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
  const { path, contents } = mailFile(name, options)
  return writeScaffoldFile(path, contents, options)
}

export function mailFile(name: string, options: WriterOptions = {}): ScaffoldFileEntry {
  return scaffoldFileEntry(name, {
    dir: MAIL_DIR,
    suffix: 'Mail',
    template: ({ normalizedName }) => buildMailSource(normalizedName),
  }, options)
}

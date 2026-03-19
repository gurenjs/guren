import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const MAIL_DIR = 'app/Mail'

function mailTemplate(className: string): string {
  return `import { Mail } from '@guren/server'

/**
 * ${className}
 */
export default class ${className} extends Mail {
  /**
   * Create a new mailable instance.
   */
  constructor(
    // Define your mail data here
    public readonly data: Record<string, unknown> = {},
  ) {
    super()
  }

  /**
   * Build the message.
   */
  build(): this {
    return this
      .subject('${className.replace(/Mail$/, '')}')
      .view('emails/${className.replace(/Mail$/, '').toLowerCase()}', this.data)
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

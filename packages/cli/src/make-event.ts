import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const EVENTS_DIR = 'app/Events'

function eventTemplate(className: string): string {
  return `import { Event } from '@guren/core'

export class ${className} extends Event {
  static override eventName = '${className}'

  constructor(
    public readonly data: Record<string, unknown> = {},
  ) {
    super()
  }
}
`
}

export async function makeEvent(name: string, options: WriterOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: EVENTS_DIR,
    template: ({ className }) => eventTemplate(className),
  }, options)
}

import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const EVENTS_DIR = 'app/Events'

function eventTemplate(className: string): string {
  return `import { Event } from '@guren/server'

/**
 * ${className}
 */
export default class ${className} extends Event {
  /**
   * The event name used for registration.
   */
  static eventName = '${className}'

  /**
   * Create a new event instance.
   */
  constructor(
    // Define your event data here
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

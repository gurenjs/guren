import type { WriterOptions } from './utils'
import { resourceName, scaffoldFile } from './utils'

const LISTENERS_DIR = 'app/Listeners'

function listenerTemplate(className: string, eventName?: string): string {
  const eventImport = eventName
    ? `import ${eventName} from '../Events/${eventName}'`
    : '// import YourEvent from \'../Events/YourEvent\''

  const eventType = eventName || 'Event'
  const eventParam = eventName ? `event: ${eventName}` : 'event: Event'
  const listenerGeneric = eventName ? `<${eventName}>` : ''
  const staticEvent = eventName ? `\n  static override event = ${eventName}\n` : ''

  return `import { Listener, Event } from '@guren/core'
${eventImport}

/**
 * ${className}
 */
export default class ${className} extends Listener${listenerGeneric} {${staticEvent}
  /**
   * Handle the event.
   */
  async handle(${eventParam}): Promise<void> {
    void event
  }

  /**
   * Queue this listener in the background when needed.
   */
  static override shouldQueue = false

  /**
   * Handle listener failure.
   */
  async failed(event: ${eventType}, error: Error): Promise<void> {
    console.error('${className} failed:', error.message)
  }
}
`
}

export interface MakeListenerOptions extends WriterOptions {
  event?: string
}

export async function makeListener(name: string, options: MakeListenerOptions = {}): Promise<string> {
  let eventClassName: string | undefined
  if (options.event) {
    eventClassName = resourceName(options.event).className
  }

  return scaffoldFile(name, {
    dir: LISTENERS_DIR,
    suffix: 'Listener',
    template: ({ normalizedName }) => listenerTemplate(normalizedName, eventClassName),
  }, options)
}

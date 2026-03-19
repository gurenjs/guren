import type { WriterOptions } from './utils'
import { resourceName, scaffoldFile } from './utils'

const LISTENERS_DIR = 'app/Listeners'

function listenerTemplate(className: string, eventName?: string): string {
  const eventImport = eventName
    ? `import ${eventName} from '../Events/${eventName}'`
    : '// import YourEvent from \'../Events/YourEvent\''

  const eventType = eventName || 'Event'
  const eventParam = eventName ? `event: ${eventName}` : 'event: Event'

  return `import { Listener, Event } from '@guren/server'
${eventImport}

/**
 * ${className}
 */
export default class ${className} extends Listener {
  /**
   * Handle the event.
   */
  async handle(${eventParam}): Promise<void> {
    // TODO: Implement listener logic
    console.log('${className} handling event:', event)
  }

  /**
   * Determine if the listener should be queued.
   */
  shouldQueue(): boolean {
    return false
  }

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

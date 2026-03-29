import type { WriterOptions } from './utils'
import { resourceName, scaffoldFile } from './utils'

const LISTENERS_DIR = 'app/Listeners'

function listenerTemplate(className: string, eventName?: string): string {
  const eventImport = eventName
    ? `import { ${eventName} } from '../Events/${eventName}'`
    : '// import { YourEvent } from \'../Events/YourEvent\''

  const eventType = eventName || 'Event'
  const eventParam = eventName ? `event: ${eventName}` : 'event: Event'
  const listenerGeneric = eventName ? `<${eventName}>` : ''
  const staticEvent = eventName ? `\n  static override event = ${eventName}\n` : ''
  const coreImports = eventName ? 'Listener' : 'Listener, Event'

  return `import { ${coreImports} } from '@guren/core'
${eventImport}

export class ${className} extends Listener${listenerGeneric} {${staticEvent}
  async handle(${eventParam}): Promise<void> {
    void event
  }

  static override shouldQueue = false

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

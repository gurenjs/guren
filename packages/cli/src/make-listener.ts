import { LISTENERS_DIR } from './discovery'
import type { ScaffoldFileEntry, WriterOptions } from './utils'
import { resourceName, scaffoldFileEntry, writeScaffoldFile } from './utils'

/** The listener `make:listener` writes, and `plan:scaffold` under the plan's class name, with no event. */
export function buildListenerSource(className: string, eventName?: string): string {
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

  // Reporting hook, not a catch. Inline, the error still propagates once
  // this has run; queued, it runs when the job has run out of retries.
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
  const { path, contents } = listenerFile(name, options)
  return writeScaffoldFile(path, contents, options)
}

export function listenerFile(name: string, options: MakeListenerOptions = {}): ScaffoldFileEntry {
  let eventClassName: string | undefined
  if (options.event) {
    eventClassName = resourceName(options.event).className
  }

  return scaffoldFileEntry(name, {
    dir: LISTENERS_DIR,
    suffix: 'Listener',
    template: ({ normalizedName }) => buildListenerSource(normalizedName, eventClassName),
  }, options)
}

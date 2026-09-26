import { EVENTS_DIR } from './discovery'
import type { ScaffoldFileEntry, WriterOptions } from './utils'
import { scaffoldFileEntry, writeScaffoldFile } from './utils'

/** The event `make:event` writes, and `plan:scaffold` under the plan's class name. */
export function buildEventSource(className: string): string {
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
  const { path, contents } = eventFile(name, options)
  return writeScaffoldFile(path, contents, options)
}

export function eventFile(name: string, options: WriterOptions = {}): ScaffoldFileEntry {
  return scaffoldFileEntry(name, {
    dir: EVENTS_DIR,
    template: ({ className }) => buildEventSource(className),
  }, options)
}

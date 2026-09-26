import { JOBS_DIR } from './discovery'
import type { ScaffoldFileEntry, WriterOptions } from './utils'
import { scaffoldFileEntry, writeScaffoldFile } from './utils'

/** The job `make:job` writes, and `plan:scaffold` under the plan's class name. */
export function buildJobSource(className: string): string {
  return `import { Job } from '@guren/core'

export interface ${className}Payload {
  [key: string]: unknown
}

export class ${className} extends Job<${className}Payload> {
  static override jobName = '${className}'
  static override queue = 'default'
  static override maxAttempts = 3

  async handle(payload: ${className}Payload): Promise<void> {
    void payload
  }

  async failed(payload: ${className}Payload, error: Error): Promise<void> {
    void payload
    console.error('${className} failed:', error.message)
  }
}
`
}

export async function makeJob(name: string, options: WriterOptions = {}): Promise<string> {
  const { path, contents } = jobFile(name, options)
  return writeScaffoldFile(path, contents, options)
}

export function jobFile(name: string, options: WriterOptions = {}): ScaffoldFileEntry {
  return scaffoldFileEntry(name, {
    dir: JOBS_DIR,
    suffix: 'Job',
    template: ({ normalizedName }) => buildJobSource(normalizedName),
  }, options)
}

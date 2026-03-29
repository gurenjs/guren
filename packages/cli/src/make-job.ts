import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const JOBS_DIR = 'app/Jobs'

function jobTemplate(className: string): string {
  return `import { Job } from '@guren/core'

export interface ${className}Payload {
  [key: string]: unknown
}

export class ${className} extends Job<${className}Payload> {
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
  return scaffoldFile(name, {
    dir: JOBS_DIR,
    suffix: 'Job',
    template: ({ normalizedName }) => jobTemplate(normalizedName),
  }, options)
}

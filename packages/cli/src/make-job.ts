import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const JOBS_DIR = 'app/Jobs'

function jobTemplate(className: string): string {
  return `import { Job } from '@guren/core'

/**
 * Payload for ${className}.
 */
export interface ${className}Payload {
  [key: string]: unknown
}

/**
 * ${className}
 */
export default class ${className} extends Job<${className}Payload> {
  /**
   * The queue this job should be dispatched to.
   */
  static override queue = 'default'

  /**
   * The number of times the job may be attempted.
   */
  static override maxAttempts = 3

  /**
   * Process the job.
   */
  async handle(payload: ${className}Payload): Promise<void> {
    void payload
  }

  /**
   * Handle a job failure.
   */
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

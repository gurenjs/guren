import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const JOBS_DIR = 'app/Jobs'

function jobTemplate(className: string): string {
  return `import { Job } from '@guren/server'

/**
 * Payload for ${className}.
 */
export interface ${className}Payload {
  // Define your job payload here
}

/**
 * ${className}
 */
export default class ${className} extends Job<${className}Payload> {
  /**
   * The queue this job should be dispatched to.
   */
  static queue = 'default'

  /**
   * The number of times the job may be attempted.
   */
  static maxAttempts = 3

  /**
   * Process the job.
   */
  async handle(): Promise<void> {
    const payload = this.getPayload()
    // TODO: Implement job logic
    console.log('Processing ${className}:', payload)
  }

  /**
   * Handle a job failure.
   */
  async failed(error: Error): Promise<void> {
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

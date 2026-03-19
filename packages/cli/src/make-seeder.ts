import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const SEEDERS_DIR = 'db/seeders'

function seederTemplate(className: string): string {
  return `import { db } from '../db'
// import { users } from '../schema'

/**
 * ${className}
 *
 * Run with: bun guren db:seed
 */
export default class ${className} {
  /**
   * Run the database seeder.
   */
  async run(): Promise<void> {
    // TODO: Implement seeder logic
    // Example:
    // await db.insert(users).values([
    //   { name: 'John Doe', email: 'john@example.com' },
    //   { name: 'Jane Doe', email: 'jane@example.com' },
    // ])
    console.log('Running ${className}...')
  }
}
`
}

export async function makeSeeder(name: string, options: WriterOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: SEEDERS_DIR,
    suffix: 'Seeder',
    template: ({ normalizedName }) => seederTemplate(normalizedName),
  }, options)
}

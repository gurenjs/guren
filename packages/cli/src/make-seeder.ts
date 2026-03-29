import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const SEEDERS_DIR = 'db/seeders'

function seederTemplate(className: string): string {
  return `import { defineSeeder } from '@guren/core'

export default defineSeeder(async () => {
  console.info('Ran ${className}.')
})
`
}

export async function makeSeeder(name: string, options: WriterOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: SEEDERS_DIR,
    suffix: 'Seeder',
    template: ({ normalizedName }) => seederTemplate(normalizedName),
  }, options)
}

import { readSchemaDialect, seederContextTypes } from './patch-helpers'
import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const SEEDERS_DIR = 'db/seeders'

function seederTemplate(className: string, context: string): string {
  return `import { defineSeeder, type ${context} } from '@guren/core'

export default defineSeeder(async ({ db }: ${context}) => {
  // await db.insert(table).values({ ... })
  console.info('Ran ${className}.')
})
`
}

export async function makeSeeder(name: string, options: WriterOptions = {}): Promise<string> {
  const context = seederContextTypes[await readSchemaDialect()]

  return scaffoldFile(name, {
    dir: SEEDERS_DIR,
    suffix: 'Seeder',
    template: ({ normalizedName }) => seederTemplate(normalizedName, context),
  }, options)
}

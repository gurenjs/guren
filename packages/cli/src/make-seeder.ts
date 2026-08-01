import { DB_ARTIFACT_DIRS } from './discovery'
import { readSchemaDialect, seederContextTypes } from './patch-helpers'
import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

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
    dir: DB_ARTIFACT_DIRS.Seeder,
    suffix: 'Seeder',
    template: ({ normalizedName }) => seederTemplate(normalizedName, context),
  }, options)
}

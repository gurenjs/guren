import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATABASE_DRIVERS, scaffoldAppBlueprint, type DatabaseDriver } from '../src/blueprints'
import { createTempWorkspace } from './helpers'

/**
 * Every column builder in a generated db/schema.ts must come from the module
 * that owns the app's dialect. Drizzle's builders share names across dialects
 * (`timestamp`, `text`, `boolean`), and mixing them is silent: drizzle-kit
 * still emits DDL and tsc still passes, so nothing downstream reports that a
 * MySQL table was built out of PostgreSQL columns.
 *
 * `@guren/orm/drizzle` re-exports the pg-core builders under those plain
 * names, which is why only the PostgreSQL scaffold may import from it.
 */
const EXPECTED_SCHEMA_MODULE = {
  postgres: '@guren/orm/drizzle',
  mysql: 'drizzle-orm/mysql-core',
  sqlite: 'drizzle-orm/sqlite-core',
} as const satisfies Record<DatabaseDriver, string>

function importedModules(source: string): string[] {
  return [...source.matchAll(/import\s*(?:\{[^}]*\}|[\w*\s,]+)\s*from\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  )
}

describe('generated db/schema.ts dialect', () => {
  for (const driver of DATABASE_DRIVERS) {
    it(`imports every builder from ${EXPECTED_SCHEMA_MODULE[driver]} for --db ${driver}`, async () => {
      const workspace = await createTempWorkspace(`guren-schema-dialect-${driver}-`)

      try {
        const dest = join(workspace.dir, 'test-app')
        await scaffoldAppBlueprint({ destination: dest, renderingMode: 'spa', database: driver })

        const schema = await readFile(join(dest, 'db/schema.ts'), 'utf8')
        const modules = importedModules(schema)

        expect(modules.length).toBeGreaterThan(0)
        expect([...new Set(modules)]).toEqual([EXPECTED_SCHEMA_MODULE[driver]])
      } finally {
        await workspace.cleanup()
      }
    })
  }
})

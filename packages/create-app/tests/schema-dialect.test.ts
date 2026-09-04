import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATABASE_DRIVERS, scaffoldAppBlueprint, type DatabaseDriver } from '../src/blueprints'
import { createTempWorkspace } from './helpers'

/**
 * Every column builder in a generated db/schema.ts must come from the app's own
 * dialect. Drizzle's builders share names across dialects and mixing them is
 * silent: drizzle-kit still emits DDL and tsc still passes. The
 * `@guren/orm/drizzle/<dialect>` barrels re-export exactly one dialect each, so
 * importing from the matching barrel is what keeps every name pure.
 */
const EXPECTED_SCHEMA_MODULE = {
  postgres: '@guren/orm/drizzle/pg',
  mysql: '@guren/orm/drizzle/mysql',
  sqlite: '@guren/orm/drizzle/sqlite',
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

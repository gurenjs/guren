import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATABASE_DRIVERS, databaseConfigTemplatePath, scaffoldAppBlueprint, type DatabaseDriver } from '../src/blueprints'
import { createTempWorkspace } from './helpers'

/**
 * The bare `SeederContext` is PostgreSQL-shaped, so a MySQL or SQLite seeder
 * typed with it cannot insert into its own schema. Every scaffold re-exports its
 * own dialect's context as `AppSeederContext`, keeping shipped seeders portable.
 */
const EXPECTED_CONTEXT = {
  postgres: 'PostgresSeederContext',
  mysql: 'MySqlSeederContext',
  sqlite: 'SqliteSeederContext',
} as const satisfies Record<DatabaseDriver, string>

// Asserted on the shipped template sources: database-config-template.test.ts
// already pins that a scaffold delivers these files byte-for-byte.
describe('shipped config/database.ts seeder context', () => {
  for (const driver of DATABASE_DRIVERS) {
    it(`re-exports ${EXPECTED_CONTEXT[driver]} as AppSeederContext for --db ${driver}`, async () => {
      const config = await readFile(databaseConfigTemplatePath(driver), 'utf8')

      expect(config).toContain(`type ${EXPECTED_CONTEXT[driver]} } from '@guren/orm'`)
      expect(config).toContain(`export type AppSeederContext = ${EXPECTED_CONTEXT[driver]}`)
    })
  }
})

// One driver is enough: the blog seeders are static template files, and
// `AppSeederContext` is the indirection that lets them stay that way.
describe('blog blueprint seeders', () => {
  it('annotates its seeders with AppSeederContext', async () => {
    const workspace = await createTempWorkspace('guren-blog-seeder-context-')

    try {
      const dest = join(workspace.dir, 'test-app')
      await scaffoldAppBlueprint({
        blueprint: 'blog',
        destination: dest,
        renderingMode: 'ssr',
        database: 'sqlite',
      })

      for (const seeder of ['db/seeders/001_users.ts', 'db/seeders/002_posts.ts']) {
        const source = await readFile(join(dest, seeder), 'utf8')
        expect(source).toContain("import type { AppSeederContext } from '../../config/database.js'")
        expect(source).toContain('async ({ db }: AppSeederContext) => {')
      }
    } finally {
      await workspace.cleanup()
    }
  })
})

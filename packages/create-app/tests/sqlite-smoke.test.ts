import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scaffoldAppBlueprint } from '../src/blueprints'
import { createTempWorkspace } from './helpers'

describe('SQLite default template', () => {
  it('scaffolds a project with SQLite instead of PostgreSQL', async () => {
    const workspace = await createTempWorkspace('sqlite-test-')

    try {
      const dest = join(workspace.dir, 'test-app')
      await scaffoldAppBlueprint({ destination: dest, renderingMode: 'spa', database: 'sqlite' })

      const dbConfig = await readFile(join(dest, 'config/database.ts'), 'utf8')
      expect(dbConfig).toContain('createSqliteDatabase')
      expect(dbConfig).not.toContain('createPostgresDatabase')
      // Test DB separation: DATABASE_URL wins, otherwise NODE_ENV=test (set
      // automatically by `bun test`) routes to a dedicated SQLite file so the
      // test suite never touches the development database.
      expect(dbConfig).toContain('guren.test.db')
      expect(dbConfig).toContain("process.env.NODE_ENV === 'test'")

      const schema = await readFile(join(dest, 'db/schema.ts'), 'utf8')
      expect(schema).toContain('sqliteTable')
      expect(schema).not.toContain('pgTable')

      const drizzleConfig = await readFile(join(dest, 'drizzle.config.ts'), 'utf8')
      expect(drizzleConfig).toContain("dialect: 'sqlite'")

      const pkg = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      expect(pkg.dependencies?.postgres).toBeUndefined()
      expect(pkg.devDependencies?.['@guren/testing']).toBeDefined()

      const env = await readFile(join(dest, '.env.example'), 'utf8')
      expect(env).toContain('guren.db')

      const gitignore = await readFile(join(dest, '.gitignore'), 'utf8')
      expect(gitignore).toContain('data/')

      const readme = await readFile(join(dest, 'README.md'), 'utf8')
      expect(readme).toContain('No Docker')
    } finally {
      await workspace.cleanup()
    }
  })
})

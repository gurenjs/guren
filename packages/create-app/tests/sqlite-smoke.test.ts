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
      await scaffoldAppBlueprint({ destination: dest, renderingMode: 'spa' })

      const dbConfig = await readFile(join(dest, 'config/database.ts'), 'utf8')
      expect(dbConfig).toContain('createSqliteDatabase')
      expect(dbConfig).not.toContain('createPostgresDatabase')

      const schema = await readFile(join(dest, 'db/schema.ts'), 'utf8')
      expect(schema).toContain('sqliteTable')
      expect(schema).not.toContain('pgTable')

      const drizzleConfig = await readFile(join(dest, 'drizzle.config.ts'), 'utf8')
      expect(drizzleConfig).toContain("dialect: 'sqlite'")

      const pkg = await readFile(join(dest, 'package.json'), 'utf8')
      expect(pkg).not.toContain('"postgres"')

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

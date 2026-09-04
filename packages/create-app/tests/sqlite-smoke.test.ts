import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scaffoldAppBlueprint } from '../src/blueprints'
import { createTempWorkspace } from './helpers'

/**
 * Extracts and evaluates the generated `resolveDatabaseFilename()` from a
 * scaffolded config/database.ts so its priority order can be exercised
 * directly against controlled process.env values, instead of trusting that
 * matching source substrings implies correct runtime behavior.
 */
function extractDatabaseFilenameResolver(source: string): () => string {
  const match = source.match(/function resolveDatabaseFilename\(\): string \{[\s\S]*?\n\}/)
  if (!match) {
    throw new Error('resolveDatabaseFilename() not found in generated config/database.ts')
  }
  // Strip the TypeScript return-type annotation — new Function() only parses plain JS.
  const plainJs = match[0].replace('(): string {', '() {')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${plainJs}\nreturn resolveDatabaseFilename;`)() as () => string
}

function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const original: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key]
  }
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    run()
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('SQLite default template', () => {
  it('scaffolds a project with SQLite instead of PostgreSQL', async () => {
    const workspace = await createTempWorkspace('sqlite-test-')

    try {
      const dest = join(workspace.dir, 'test-app')
      await scaffoldAppBlueprint({ destination: dest, renderingMode: 'spa', database: 'sqlite' })

      const dbConfig = await readFile(join(dest, 'config/database.ts'), 'utf8')
      expect(dbConfig).toContain('createSqliteDatabase')
      expect(dbConfig).not.toContain('createPostgresDatabase')
      // NODE_ENV=test (set by `bun test`) routes to a dedicated SQLite file and
      // takes priority over DATABASE_URL, which .env sets unconditionally.
      expect(dbConfig).toContain('guren.test.db')
      expect(dbConfig).toContain("process.env.NODE_ENV === 'test'")

      const resolveDatabaseFilename = extractDatabaseFilenameResolver(dbConfig)

      // A scaffolded .env always sets DATABASE_URL and Bun loads .env even under
      // test, so NODE_ENV=test must win over an inherited DATABASE_URL for the
      // isolation to actually happen.
      withEnv(
        { NODE_ENV: 'test', DATABASE_URL: './data/guren.db', TEST_DATABASE_URL: undefined },
        () => {
          expect(resolveDatabaseFilename()).toBe('./data/guren.test.db')
        },
      )

      withEnv(
        { NODE_ENV: 'test', DATABASE_URL: './data/guren.db', TEST_DATABASE_URL: './data/shard-3.db' },
        () => {
          expect(resolveDatabaseFilename()).toBe('./data/shard-3.db')
        },
      )

      withEnv({ NODE_ENV: 'production', DATABASE_URL: undefined }, () => {
        expect(resolveDatabaseFilename()).toBe('./data/guren.db')
      })

      withEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://example' }, () => {
        expect(resolveDatabaseFilename()).toBe('postgres://example')
      })

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

describe('API-only SQLite template', () => {
  it('routes bun test to a dedicated DB even with DATABASE_URL set via .env', async () => {
    const workspace = await createTempWorkspace('sqlite-api-test-')

    try {
      const dest = join(workspace.dir, 'test-app')
      await scaffoldAppBlueprint({
        destination: dest,
        renderingMode: 'spa',
        database: 'sqlite',
        blueprint: 'api',
      })

      const dbConfig = await readFile(join(dest, 'config/database.ts'), 'utf8')
      expect(dbConfig).toContain('guren.test.db')

      const resolveDatabaseFilename = extractDatabaseFilenameResolver(dbConfig)
      withEnv(
        { NODE_ENV: 'test', DATABASE_URL: './data/guren.db', TEST_DATABASE_URL: undefined },
        () => {
          expect(resolveDatabaseFilename()).toBe('./data/guren.test.db')
        },
      )

      const pkg = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8')) as {
        devDependencies?: Record<string, string>
      }
      expect(pkg.devDependencies?.['@guren/testing']).toBeDefined()
    } finally {
      await workspace.cleanup()
    }
  })
})

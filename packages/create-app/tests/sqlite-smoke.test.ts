import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scaffoldAppBlueprint } from '../src/blueprints'
import { createTempWorkspace } from './helpers'

interface ResolverEnv {
  DATABASE_URL?: string
  TEST_DATABASE_URL?: string
}

type FilenameResolver = (context?: { env: ResolverEnv }) => string

/**
 * Extracts and evaluates the generated `filename` resolver from a scaffolded
 * config/database.ts so its priority order can be exercised directly against
 * controlled values, instead of trusting that matching source substrings
 * implies correct runtime behavior. `schema` stands in for the `config/env.ts`
 * the file closes over, which only a call with no context may reach.
 */
function extractDatabaseFilenameResolver(
  source: string,
  schema: { parse: (source?: unknown, options?: { mode?: string }) => { values: ResolverEnv } },
): FilenameResolver {
  const match = source.match(/filename: (\(context\) => \{[\s\S]*?\n {2}\}),/)
  if (!match) {
    throw new Error('filename resolver not found in generated config/database.ts')
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('env', `return ${match[1]}`)(schema) as FilenameResolver
}

/** A schema whose use is a failure: every call that passes a context must not reach it. */
const unusedSchema = {
  parse: (): { values: ResolverEnv } => {
    throw new Error('resolved through config/env.ts despite being given a context')
  },
}

function withNodeEnv(value: string, run: () => void): void {
  const original = process.env.NODE_ENV
  try {
    process.env.NODE_ENV = value
    run()
  } finally {
    if (original === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = original
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

      const resolveDatabaseFilename = extractDatabaseFilenameResolver(dbConfig, unusedSchema)

      // A scaffolded .env always sets DATABASE_URL and Bun loads .env even under
      // test, so NODE_ENV=test must win over an inherited DATABASE_URL for the
      // isolation to actually happen.
      withNodeEnv('test', () => {
        expect(resolveDatabaseFilename({ env: { DATABASE_URL: './data/guren.db' } }))
          .toBe('./data/guren.test.db')
      })

      withNodeEnv('test', () => {
        expect(resolveDatabaseFilename({
          env: { DATABASE_URL: './data/guren.db', TEST_DATABASE_URL: './data/shard-3.db' },
        })).toBe('./data/shard-3.db')
      })

      withNodeEnv('production', () => {
        expect(resolveDatabaseFilename({ env: {} })).toBe('./data/guren.db')
      })

      withNodeEnv('production', () => {
        expect(resolveDatabaseFilename({ env: { DATABASE_URL: 'postgres://example' } }))
          .toBe('postgres://example')
      })

      // `guren db:*` resolves with no context, where the file parses config/env.ts
      // itself, in report mode: a production migration must not need APP_KEY.
      const modes: Array<string | undefined> = []
      const schemaBacked = extractDatabaseFilenameResolver(dbConfig, {
        parse: (_source, options) => {
          modes.push(options?.mode)
          return { values: { DATABASE_URL: './data/from-schema.db' } }
        },
      })
      withNodeEnv('production', () => {
        expect(schemaBacked()).toBe('./data/from-schema.db')
      })
      expect(modes).toEqual(['report'])

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

      const resolveDatabaseFilename = extractDatabaseFilenameResolver(dbConfig, unusedSchema)
      withNodeEnv('test', () => {
        expect(resolveDatabaseFilename({ env: { DATABASE_URL: './data/guren.db' } }))
          .toBe('./data/guren.test.db')
      })

      const pkg = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8')) as {
        devDependencies?: Record<string, string>
      }
      expect(pkg.devDependencies?.['@guren/testing']).toBeDefined()
    } finally {
      await workspace.cleanup()
    }
  })
})

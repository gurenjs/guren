import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scaffoldAppBlueprint } from '../src/blueprints'
import { createTempWorkspace } from './helpers'

/**
 * `DATABASE_URL` names the SQLite database for two different implementations:
 * the app opens it with `bun:sqlite`, drizzle-kit with `node:sqlite`. Only the
 * first honours URI filenames, so `file:local.db` migrates the app into
 * `local.db` and drizzle-kit into a file *named* `file:local.db` — two
 * databases, no error from either. The generated config refuses any scheme so
 * that split cannot happen, and these tests run the generated file rather than
 * matching its text, so a guard that is present but inert still fails.
 *
 * Postgres and MySQL take a real connection string here and must not inherit
 * the check.
 */
function runGeneratedConfig(source: string, databaseUrl?: string): { dbCredentials: { url: string } } {
  const body = source
    .replace("import { defineConfig } from 'drizzle-kit'", 'const defineConfig = (config) => config')
    .replace('export default ', 'return ')

  return new Function('process', body)({ env: { DATABASE_URL: databaseUrl } })
}

async function generateConfig(driver: 'sqlite' | 'postgres' | 'mysql'): Promise<string> {
  const workspace = await createTempWorkspace(`guren-drizzle-guard-${driver}-`)
  try {
    const dest = join(workspace.dir, 'test-app')
    await scaffoldAppBlueprint({ destination: dest, renderingMode: 'spa', database: driver })
    return await readFile(join(dest, 'drizzle.config.ts'), 'utf8')
  } finally {
    await workspace.cleanup()
  }
}

describe('generated drizzle.config.ts DATABASE_URL guard', () => {
  it('refuses a connection string for --db sqlite', async () => {
    const config = await generateConfig('sqlite')

    expect(() => runGeneratedConfig(config, 'postgres://guren:guren@localhost:54322/guren')).toThrow(
      /must be a plain file path/,
    )
  })

  // The value both guards used to allow, and the one that splits silently
  // rather than failing: neither implementation errors on it.
  it('refuses a file: URI for --db sqlite', async () => {
    const config = await generateConfig('sqlite')

    expect(() => runGeneratedConfig(config, 'file:local.db')).toThrow(/must be a plain file path/)
    expect(() => runGeneratedConfig(config, 'file::memory:')).toThrow(/must be a plain file path/)
  })

  it.each(['./data/guren.db', '/srv/data/app.db', 'data/app.db', ':memory:', 'C:/data/app.db'])(
    'accepts %p for --db sqlite',
    async (url) => {
      const config = await generateConfig('sqlite')

      expect(runGeneratedConfig(config, url).dbCredentials.url).toBe(url)
    },
  )

  it('falls back to the default path when DATABASE_URL is unset', async () => {
    const config = await generateConfig('sqlite')

    expect(runGeneratedConfig(config, undefined).dbCredentials.url).toBe('./data/guren.db')
  })

  it.each(['postgres', 'mysql'] as const)('leaves a %s connection string alone', async (driver) => {
    const config = await generateConfig(driver)
    const url = driver === 'postgres' ? 'postgres://guren@localhost:54322/guren' : 'mysql://guren@localhost:33306/guren'

    expect(runGeneratedConfig(config, url).dbCredentials.url).toBe(url)
  })
})

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scaffoldAppBlueprint } from '../src/blueprints'
import { createTempWorkspace } from './helpers'

/**
 * The app opens `DATABASE_URL` with `bun:sqlite`, drizzle-kit with
 * `node:sqlite`; only the first honours URI filenames, so `file:local.db` gives
 * two databases and no error from either. The config refuses any scheme, and
 * these tests run the generated file so an inert guard still fails. Postgres and
 * MySQL take a real connection string and must not inherit the check.
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

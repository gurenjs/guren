import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DATABASE_CONFIG_CANDIDATES = [
  'config/database.ts',
  'config/database.js',
  'config/database.mjs',
  'config/database.cjs',
]

async function importModule(path: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(path).href
  return import(url)
}

export async function resolveDatabaseModule(): Promise<Record<string, unknown>> {
  const cwd = process.cwd()

  for (const candidate of DATABASE_CONFIG_CANDIDATES) {
    const absolutePath = resolve(cwd, candidate)

    try {
      await access(absolutePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }

      throw error
    }

    return importModule(absolutePath)
  }

  throw new Error('Could not find config/database.(ts|js) in the current working directory.')
}

function pickFunction(module: Record<string, unknown>, names: string[]): (() => Promise<unknown>) | undefined {
  for (const name of names) {
    const value = module[name as keyof typeof module]
    if (typeof value === 'function') {
      return value as () => Promise<unknown>
    }
  }

  const defaultExport = module.default
  if (defaultExport && typeof defaultExport === 'object') {
    for (const name of names) {
      const value = (defaultExport as Record<string, unknown>)[name]
      if (typeof value === 'function') {
        return value as () => Promise<unknown>
      }
    }
  }

  return undefined
}

export async function runDatabaseMigrations(): Promise<void> {
  const module = await resolveDatabaseModule()
  const migrate = pickFunction(module, ['migrateDatabase', 'runMigrations', 'getDatabase'])
  const close = pickFunction(module, ['closeDatabase'])

  if (!migrate) {
    throw new Error('config/database.ts must export migrateDatabase(), runMigrations(), or getDatabase().')
  }

  try {
    await migrate()
  } finally {
    if (close) {
      await close()
    }
  }
}

export async function runDatabaseSeeders(): Promise<void> {
  const module = await resolveDatabaseModule()
  const seed = pickFunction(module, ['seedDatabase', 'runSeeders'])
  const close = pickFunction(module, ['closeDatabase'])

  if (!seed) {
    throw new Error('config/database.ts must export seedDatabase() or runSeeders().')
  }

  try {
    await seed()
  } finally {
    if (close) {
      await close()
    }
  }
}

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { consola } from 'consola'

const SEEDERS_DIR = 'db/seeders'
const DEFAULT_SEEDER = 'DatabaseSeeder'

interface DbSeedOptions {
  class?: string
  force?: boolean
  silent?: boolean
}

/**
 * Run database seeders.
 */
export async function dbSeed(options: DbSeedOptions = {}): Promise<void> {
  const seederName = options.class ?? DEFAULT_SEEDER
  const force = options.force ?? false
  const silent = options.silent ?? false

  // Check production safety
  if (process.env.NODE_ENV === 'production' && !force) {
    consola.error('Refusing to run seeders in production. Use --force to override.')
    process.exit(1)
  }

  const seedersPath = join(process.cwd(), SEEDERS_DIR)

  if (!existsSync(seedersPath)) {
    consola.error(`Seeders directory not found: ${seedersPath}`)
    consola.info('Run "bun guren make:seeder DatabaseSeeder" to create one.')
    process.exit(1)
  }

  const seederFile = join(seedersPath, `${seederName}.ts`)

  if (!existsSync(seederFile)) {
    consola.error(`Seeder not found: ${seederFile}`)
    const available = await getAvailableSeeders()
    if (available.length > 0) {
      consola.info(`Available seeders: ${available.join(', ')}`)
    }
    process.exit(1)
  }

  try {
    if (!silent) {
      consola.info(`Seeding: ${seederName}`)
    }

    const module = await import(seederFile)
    const SeederClass = module.default ?? module[seederName]

    if (!SeederClass) {
      consola.error(`Seeder "${seederName}" does not export a default class.`)
      process.exit(1)
    }

    const seeder = new SeederClass()

    if (typeof seeder.run !== 'function') {
      consola.error(`Seeder "${seederName}" does not have a run() method.`)
      process.exit(1)
    }

    await seeder.run()

    if (!silent) {
      consola.success(`Seeded: ${seederName}`)
    }
  } catch (error) {
    consola.error(`Failed to run seeder: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

/**
 * Get available seeders.
 */
async function getAvailableSeeders(): Promise<string[]> {
  const seedersPath = join(process.cwd(), SEEDERS_DIR)

  if (!existsSync(seedersPath)) {
    return []
  }

  const files = await readdir(seedersPath)
  return files
    .filter((file) => file.endsWith('.ts') && !file.startsWith('_'))
    .map((file) => file.replace('.ts', ''))
}

/**
 * List available seeders.
 */
export async function dbSeedList(): Promise<void> {
  const seeders = await getAvailableSeeders()

  if (seeders.length === 0) {
    consola.info('No seeders found.')
    consola.info('Run "bun guren make:seeder DatabaseSeeder" to create one.')
    return
  }

  consola.info('Available seeders:')
  for (const seeder of seeders) {
    const isDefault = seeder === DEFAULT_SEEDER
    console.log(`  ${seeder}${isDefault ? ' (default)' : ''}`)
  }
}

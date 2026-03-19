import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'

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
    console.error(
      'Error: Refusing to run seeders in production. Use --force to override.'
    )
    process.exit(1)
  }

  const seedersPath = join(process.cwd(), SEEDERS_DIR)

  if (!existsSync(seedersPath)) {
    console.error(`Error: Seeders directory not found: ${seedersPath}`)
    console.error('Run "bun guren make:seeder DatabaseSeeder" to create one.')
    process.exit(1)
  }

  const seederFile = join(seedersPath, `${seederName}.ts`)

  if (!existsSync(seederFile)) {
    console.error(`Error: Seeder not found: ${seederFile}`)
    const available = await getAvailableSeeders()
    if (available.length > 0) {
      console.error(`Available seeders: ${available.join(', ')}`)
    }
    process.exit(1)
  }

  try {
    if (!silent) {
      console.log(`Seeding: ${seederName}`)
    }

    const module = await import(seederFile)
    const SeederClass = module.default ?? module[seederName]

    if (!SeederClass) {
      console.error(
        `Error: Seeder "${seederName}" does not export a default class`
      )
      process.exit(1)
    }

    const seeder = new SeederClass()

    if (typeof seeder.run !== 'function') {
      console.error(`Error: Seeder "${seederName}" does not have a run() method`)
      process.exit(1)
    }

    await seeder.run()

    if (!silent) {
      console.log(`Seeded: ${seederName}`)
    }
  } catch (error) {
    console.error(`Error running seeder: ${error instanceof Error ? error.message : String(error)}`)
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
    console.log('No seeders found.')
    console.log('Run "bun guren make:seeder DatabaseSeeder" to create one.')
    return
  }

  console.log('Available seeders:')
  for (const seeder of seeders) {
    const isDefault = seeder === DEFAULT_SEEDER
    console.log(`  ${seeder}${isDefault ? ' (default)' : ''}`)
  }
}

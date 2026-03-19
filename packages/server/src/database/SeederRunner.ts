import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { SeederClass, SeederRunnerOptions } from './types'
import { resetCalledSeeders } from './Seeder'

/**
 * Seeder runner for executing database seeders.
 */
export class SeederRunner {
  private options: Required<SeederRunnerOptions>
  private seeders: Map<string, SeederClass> = new Map()

  constructor(options: SeederRunnerOptions = {}) {
    this.options = {
      seedersPath: options.seedersPath ?? 'db/seeders',
      defaultSeeder: options.defaultSeeder ?? 'DatabaseSeeder',
      force: options.force ?? false,
      silent: options.silent ?? false,
    }
  }

  /**
   * Register a seeder class.
   */
  register(name: string, seeder: SeederClass): this {
    this.seeders.set(name, seeder)
    return this
  }

  /**
   * Register multiple seeder classes.
   */
  registerMany(seeders: Record<string, SeederClass>): this {
    for (const [name, seeder] of Object.entries(seeders)) {
      this.register(name, seeder)
    }
    return this
  }

  /**
   * Run a specific seeder by name or class.
   */
  async run(seeder?: string | SeederClass): Promise<void> {
    // Check production safety
    if (process.env.NODE_ENV === 'production' && !this.options.force) {
      throw new Error(
        'Refusing to run seeders in production. Use --force to override.'
      )
    }

    // Reset called seeders tracking
    resetCalledSeeders()

    // Determine which seeder to run
    let SeederClass: SeederClass

    if (typeof seeder === 'string') {
      SeederClass = await this.resolveSeeder(seeder)
    } else if (seeder) {
      SeederClass = seeder
    } else {
      SeederClass = await this.resolveSeeder(this.options.defaultSeeder)
    }

    // Run the seeder
    this.log(`Running ${SeederClass.name}...`)

    const instance = new SeederClass()
    await instance.run()

    this.log(`${SeederClass.name} completed.`)
  }

  /**
   * Run multiple seeders in sequence.
   */
  async runMany(seeders: Array<string | SeederClass>): Promise<void> {
    for (const seeder of seeders) {
      await this.run(seeder)
    }
  }

  /**
   * Resolve a seeder by name.
   */
  private async resolveSeeder(name: string): Promise<SeederClass> {
    // Check registered seeders first
    if (this.seeders.has(name)) {
      return this.seeders.get(name)!
    }

    // Try to load from file
    const filePath = join(process.cwd(), this.options.seedersPath, `${name}.ts`)

    if (!existsSync(filePath)) {
      throw new Error(`Seeder "${name}" not found at ${filePath}`)
    }

    try {
      const module = await import(filePath)
      const SeederClass = module.default ?? module[name]

      if (!SeederClass) {
        throw new Error(
          `Seeder "${name}" does not export a default class or named export`
        )
      }

      return SeederClass
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        throw error
      }
      throw new Error(
        `Failed to load seeder "${name}": ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Get available seeders from the seeders directory.
   */
  async getAvailableSeeders(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises')
    const seedersPath = join(process.cwd(), this.options.seedersPath)

    if (!existsSync(seedersPath)) {
      return []
    }

    const files = await readdir(seedersPath)
    return files
      .filter((file) => file.endsWith('.ts') && !file.startsWith('_'))
      .map((file) => file.replace('.ts', ''))
  }

  /**
   * Log a message if not silent.
   */
  private log(message: string): void {
    if (!this.options.silent) {
      console.log(message)
    }
  }
}

/**
 * Create a seeder runner.
 */
export function createSeederRunner(options?: SeederRunnerOptions): SeederRunner {
  return new SeederRunner(options)
}

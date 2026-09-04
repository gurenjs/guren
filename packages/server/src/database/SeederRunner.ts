import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { SeederClass, SeederRunnerOptions } from './types'
// Deprecated alongside this runner: the two halves of the same convention.
import { resetCalledSeeders } from './Seeder'
import { warnOnce } from '../support/warn-once'

/**
 * @deprecated No Guren command reaches this runner. Write seeders with
 * `defineSeeder` from `@guren/core` and run them with `db:seed`. Deprecated
 * in 2.9.0, removed in 3.0.0.
 *
 * It runs a single seeder per call and invokes `.run()` with no context,
 * unlike `runSeeders()`, which hands every seeder a `{ db }` context.
 */
export class SeederRunner {
  private options: Required<SeederRunnerOptions>
  private seeders: Map<string, SeederClass> = new Map()

  constructor(options: SeederRunnerOptions = {}) {
    warnOnce(
      'seeder-class-convention:seeder-runner',
      '[guren] Deprecation (seeder-class-convention): SeederRunner is deprecated\n'
        + '  since 2.9.0, will be removed in 3.0.0.\n'
        + "  No Guren command runs it. Write seeders with defineSeeder from '@guren/core' "
        + 'and run them with `guren db:seed`.',
    )
    this.options = {
      seedersPath: options.seedersPath ?? 'db/seeders',
      defaultSeeder: options.defaultSeeder ?? 'DatabaseSeeder',
      force: options.force ?? false,
      silent: options.silent ?? false,
    }
  }

  register(name: string, seeder: SeederClass): this {
    this.seeders.set(name, seeder)
    return this
  }

  registerMany(seeders: Record<string, SeederClass>): this {
    for (const [name, seeder] of Object.entries(seeders)) {
      this.register(name, seeder)
    }
    return this
  }

  async run(seeder?: string | SeederClass): Promise<void> {
    if (process.env.NODE_ENV === 'production' && !this.options.force) {
      throw new Error(
        'Refusing to run seeders in production. Use --force to override.'
      )
    }

    resetCalledSeeders()

    let SeederClass: SeederClass

    if (typeof seeder === 'string') {
      SeederClass = await this.resolveSeeder(seeder)
    } else if (seeder) {
      SeederClass = seeder
    } else {
      SeederClass = await this.resolveSeeder(this.options.defaultSeeder)
    }

    this.log(`Running ${SeederClass.name}...`)

    const instance = new SeederClass()
    await instance.run()

    this.log(`${SeederClass.name} completed.`)
  }

  async runMany(seeders: Array<string | SeederClass>): Promise<void> {
    for (const seeder of seeders) {
      await this.run(seeder)
    }
  }

  private async resolveSeeder(name: string): Promise<SeederClass> {
    if (this.seeders.has(name)) {
      return this.seeders.get(name)!
    }

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

  /** The seeder names found in the seeders directory. */
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

  private log(message: string): void {
    if (!this.options.silent) {
      console.log(message)
    }
  }
}

/**
 * @deprecated No Guren command reaches this runner. Write seeders with
 * `defineSeeder` from `@guren/core` instead. Deprecated in 2.9.0, removed in
 * 3.0.0. See {@link SeederRunner}.
 */
export function createSeederRunner(options?: SeederRunnerOptions): SeederRunner {
  return new SeederRunner(options)
}

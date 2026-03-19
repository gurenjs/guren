import type { SeederClass } from './types'

/**
 * Track which seeders have been called with callOnce.
 */
const calledSeeders = new Set<string>()

/**
 * Reset called seeders tracking (for testing).
 */
export function resetCalledSeeders(): void {
  calledSeeders.clear()
}

/**
 * Abstract base class for database seeders.
 */
export abstract class BaseSeeder {
  /**
   * Run the seeder.
   */
  abstract run(): Promise<void>

  /**
   * Call another seeder.
   */
  protected async call(SeederClass: SeederClass): Promise<void> {
    const seeder = new SeederClass()
    await seeder.run()
  }

  /**
   * Call another seeder only once.
   * Useful for avoiding duplicate data when seeders have dependencies.
   */
  protected async callOnce(SeederClass: SeederClass): Promise<void> {
    const name = SeederClass.name

    if (calledSeeders.has(name)) {
      return
    }

    calledSeeders.add(name)
    await this.call(SeederClass)
  }

  /**
   * Call multiple seeders in sequence.
   */
  protected async callMany(seeders: SeederClass[]): Promise<void> {
    for (const SeederClass of seeders) {
      await this.call(SeederClass)
    }
  }

  /**
   * Call multiple seeders in parallel.
   */
  protected async callParallel(seeders: SeederClass[]): Promise<void> {
    await Promise.all(
      seeders.map((SeederClass) => this.call(SeederClass))
    )
  }
}

/**
 * Alias for BaseSeeder.
 */
export { BaseSeeder as Seeder }

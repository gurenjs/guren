import type { SeederClass } from './types'
import { warnOnce } from '../support/warn-once'

/** Which seeders have been called through `callOnce`. */
const calledSeeders = new Set<string>()

/**
 * @deprecated Bookkeeping for {@link BaseSeeder}'s `callOnce`. Write seeders
 * with `defineSeeder` from `@guren/core` instead, which needs no such
 * tracking. Deprecated in 2.9.0, removed in 3.0.0.
 */
export function resetCalledSeeders(): void {
  calledSeeders.clear()
}

/**
 * @deprecated Write seeders with `defineSeeder` from `@guren/core` instead.
 * Deprecated in 2.9.0, removed in 3.0.0.
 *
 * The signature is the problem: `run()` takes no parameters, so it hides the
 * `{ db }` context `runSeeders()` passes, and a subclass cannot widen it
 * (TS2416). The orchestration these classes were written for, `SeederRunner`,
 * is reached by no Guren command.
 */
export abstract class BaseSeeder {
  constructor() {
    warnOnce(
      'seeder-class-convention:base-seeder',
      '[guren] Deprecation (seeder-class-convention): BaseSeeder/Seeder is deprecated\n'
        + '  since 2.9.0, will be removed in 3.0.0.\n'
        + "  Write seeders with defineSeeder from '@guren/core': its handler receives { db }, "
        + 'which BaseSeeder.run() is declared not to take.',
    )
  }

  /**
   * Declared without parameters: `runSeeders()` calls it with a `{ db }`
   * context this signature cannot name.
   */
  abstract run(): Promise<void>

  /** No context is forwarded: the child's `run()` gets no arguments. */
  protected async call(SeederClass: SeederClass): Promise<void> {
    const seeder = new SeederClass()
    await seeder.run()
  }

  /** Skips the seeder if it already ran in this process. */
  protected async callOnce(SeederClass: SeederClass): Promise<void> {
    const name = SeederClass.name

    if (calledSeeders.has(name)) {
      return
    }

    calledSeeders.add(name)
    await this.call(SeederClass)
  }

  protected async callMany(seeders: SeederClass[]): Promise<void> {
    for (const SeederClass of seeders) {
      await this.call(SeederClass)
    }
  }

  protected async callParallel(seeders: SeederClass[]): Promise<void> {
    await Promise.all(
      seeders.map((SeederClass) => this.call(SeederClass))
    )
  }
}

/**
 * @deprecated Write seeders with `defineSeeder` from `@guren/core` instead.
 * Deprecated in 2.9.0, removed in 3.0.0. See {@link BaseSeeder}.
 */
export { BaseSeeder as Seeder }

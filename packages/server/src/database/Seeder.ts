import type { SeederClass } from './types'
import { warnOnce } from '../support/warn-once'

/**
 * Track which seeders have been called with callOnce.
 */
const calledSeeders = new Set<string>()

/**
 * Reset called seeders tracking (for testing).
 *
 * @deprecated Bookkeeping for {@link BaseSeeder}'s `callOnce`. Write seeders
 * with `defineSeeder` from `@guren/core` instead, which needs no such
 * tracking. Deprecated in 2.9.0, removed in 3.0.0.
 */
export function resetCalledSeeders(): void {
  calledSeeders.clear()
}

/**
 * Abstract base class for database seeders.
 *
 * @deprecated Write seeders with `defineSeeder` from `@guren/core` instead.
 * Deprecated in 2.9.0, removed in 3.0.0.
 *
 * A seeder class is not itself the problem: `db:seed` loads every seeder
 * through `runSeeders()`, which does accept an exported class whose prototype
 * has a `run` method, constructs it, and calls `run({ db })`. What this base
 * class gets wrong is the signature it imposes on that method. `run()` is
 * declared to take no parameters, so it hides the one argument a seeder
 * needs.
 *
 * A subclass cannot simply correct that: declaring `run(ctx: SeederContext)`
 * fails to compile against the base (`TS2416: Target signature provides too
 * few arguments. Expected 1 or more, but got 0`). Widening it to an optional
 * `run(ctx?: SeederContext)` does compile, but then the subclass has to handle
 * a missing context — and that case is real, because
 * {@link BaseSeeder.call}, {@link BaseSeeder.callOnce},
 * {@link BaseSeeder.callMany} and {@link BaseSeeder.callParallel} construct
 * child seeders and invoke `run()` with no arguments at all. A parent that
 * received a context cannot pass it down.
 *
 * The orchestration these classes were written for, `SeederRunner`, is
 * reached by no Guren command.
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
   * Run the seeder.
   *
   * Declared without parameters, which is what makes this class the wrong
   * base: `runSeeders()` calls it with a `{ db }` context that this signature
   * cannot name.
   */
  abstract run(): Promise<void>

  /**
   * Call another seeder.
   *
   * No context is forwarded: the child's `run()` is invoked with no
   * arguments, whatever the caller itself received.
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
 *
 * @deprecated Write seeders with `defineSeeder` from `@guren/core` instead.
 * Deprecated in 2.9.0, removed in 3.0.0. See {@link BaseSeeder}.
 */
export { BaseSeeder as Seeder }

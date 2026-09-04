/**
 * @deprecated The constructor shape `BaseSeeder` and `SeederRunner` expect.
 * Write seeders with `defineSeeder` from `@guren/core` instead. Deprecated in
 * 2.9.0, removed in 3.0.0.
 */
export interface SeederClass {
  new (): Seeder
}

/**
 * Exported from the package root as `SeederInterface`.
 *
 * @deprecated The no-context `run()` shape `BaseSeeder` imposes. Write seeders
 * with `defineSeeder` from `@guren/core` instead, whose handler is typed to
 * receive `{ db }`. Deprecated in 2.9.0, removed in 3.0.0.
 */
export interface Seeder {
  run(): Promise<void>
}

export interface FactoryClass<T> {
  new (): Factory<T>
}

export interface Factory<T> {
  definition(): Partial<T>
  make(overrides?: Partial<T>): T
  makeMany(count: number, overrides?: Partial<T>): T[]
  create(overrides?: Partial<T>): Promise<T>
  createMany(count: number, overrides?: Partial<T>): Promise<T[]>
}

/**
 * @deprecated Options for `SeederRunner`, which no Guren command reaches.
 * Write seeders with `defineSeeder` from `@guren/core` and run them with
 * `db:seed`. Deprecated in 2.9.0, removed in 3.0.0.
 */
export interface SeederRunnerOptions {
  seedersPath?: string

  /** Default seeder class name. */
  defaultSeeder?: string

  /** Force run in production. */
  force?: boolean

  /** No console output. */
  silent?: boolean
}

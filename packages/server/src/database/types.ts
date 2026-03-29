/**
 * Seeder class interface.
 */
export interface SeederClass {
  new (): Seeder
}

/**
 * Abstract seeder interface.
 */
export interface Seeder {
  run(): Promise<void>
}

/**
 * Factory class interface.
 */
export interface FactoryClass<T> {
  new (): Factory<T>
}

/**
 * Abstract factory interface.
 */
export interface Factory<T> {
  definition(): Partial<T>
  make(overrides?: Partial<T>): T
  makeMany(count: number, overrides?: Partial<T>): T[]
  create(overrides?: Partial<T>): Promise<T>
  createMany(count: number, overrides?: Partial<T>): Promise<T[]>
}

/**
 * Seeder runner options.
 */
export interface SeederRunnerOptions {
  /**
   * Path to seeders directory.
   */
  seedersPath?: string

  /**
   * Default seeder class name.
   */
  defaultSeeder?: string

  /**
   * Force run in production.
   */
  force?: boolean

  /**
   * Silent mode (no console output).
   */
  silent?: boolean
}

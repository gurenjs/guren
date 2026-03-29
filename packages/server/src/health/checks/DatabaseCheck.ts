import type { CheckResult } from '../types'
import { HealthCheck } from '../HealthCheck'

/**
 * Database connection interface (minimal).
 */
export interface DatabaseConnection {
  query(sql: string): Promise<unknown>
}

/**
 * Options for database health check.
 */
export interface DatabaseCheckOptions {
  /**
   * Custom name for this check.
   * @default 'database'
   */
  name?: string

  /**
   * Custom query to execute.
   * @default 'SELECT 1'
   */
  query?: string
}

/**
 * Health check for database connectivity.
 */
export class DatabaseCheck extends HealthCheck {
  readonly name: string

  private db: DatabaseConnection
  private query: string

  constructor(db: DatabaseConnection, options: DatabaseCheckOptions = {}) {
    super()
    this.db = db
    this.name = options.name ?? 'database'
    this.query = options.query ?? 'SELECT 1'
  }

  async check(): Promise<CheckResult> {
    try {
      await this.db.query(this.query)
      return this.healthy('Database connection is healthy')
    } catch (error) {
      return this.handleError(error, 'Database connection failed')
    }
  }
}

import type { CheckResult } from '../types'
import { HealthCheck } from '../HealthCheck'

export interface RedisClient {
  ping(): Promise<string>
}

export interface RedisCheckOptions {
  /** @default 'redis' */
  name?: string
}

export class RedisCheck extends HealthCheck {
  readonly name: string

  private redis: RedisClient

  constructor(redis: RedisClient, options: RedisCheckOptions = {}) {
    super()
    this.redis = redis
    this.name = options.name ?? 'redis'
  }

  async check(): Promise<CheckResult> {
    try {
      const response = await this.redis.ping()
      if (response === 'PONG') {
        return this.healthy('Redis connection is healthy')
      }
      return this.degraded(`Redis ping returned: ${response}`)
    } catch (error) {
      return this.handleError(error, 'Redis connection failed')
    }
  }
}

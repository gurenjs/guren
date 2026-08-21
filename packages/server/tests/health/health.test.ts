import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import {
  HealthCheck,
  HealthManager,
  createHealthManager,
  DatabaseCheck,
  RedisCheck,
  CacheCheck,
  StorageCheck,
  MemoryCheck,
  CustomCheck,
  customCheck,
} from '../../src/health'
import type { CacheStoreInterface, CheckResult, HealthStatus } from '../../src/health'

// ============================================================
// HealthCheck (Base Class) Tests
// ============================================================

describe('HealthCheck', () => {
  class TestCheck extends HealthCheck {
    readonly name = 'test'
    private _status: HealthStatus = 'healthy'
    private _message?: string
    private _meta?: Record<string, unknown>

    setStatus(status: HealthStatus, message?: string, meta?: Record<string, unknown>) {
      this._status = status
      this._message = message
      this._meta = meta
    }

    async check(): Promise<CheckResult> {
      switch (this._status) {
        case 'healthy':
          return this.healthy(this._message, this._meta)
        case 'degraded':
          return this.degraded(this._message, this._meta)
        case 'unhealthy':
          return this.unhealthy(this._message, this._meta)
      }
    }
  }

  it('should create healthy result', async () => {
    const check = new TestCheck()
    check.setStatus('healthy', 'All good')

    const result = await check.check()

    expect(result.name).toBe('test')
    expect(result.status).toBe('healthy')
    expect(result.message).toBe('All good')
  })

  it('should create degraded result', async () => {
    const check = new TestCheck()
    check.setStatus('degraded', 'Slow response')

    const result = await check.check()

    expect(result.name).toBe('test')
    expect(result.status).toBe('degraded')
    expect(result.message).toBe('Slow response')
  })

  it('should create unhealthy result', async () => {
    const check = new TestCheck()
    check.setStatus('unhealthy', 'Connection failed')

    const result = await check.check()

    expect(result.name).toBe('test')
    expect(result.status).toBe('unhealthy')
    expect(result.message).toBe('Connection failed')
  })

  it('should include meta data', async () => {
    const check = new TestCheck()
    check.setStatus('healthy', 'OK', { latency: 5, version: '1.0' })

    const result = await check.check()

    expect(result.meta).toEqual({ latency: 5, version: '1.0' })
  })

  it('should work without message or meta', async () => {
    const check = new TestCheck()
    check.setStatus('healthy')

    const result = await check.check()

    expect(result.status).toBe('healthy')
    expect(result.message).toBeUndefined()
    expect(result.meta).toBeUndefined()
  })
})

// ============================================================
// HealthManager Tests
// ============================================================

describe('HealthManager', () => {
  class SimpleCheck extends HealthCheck {
    constructor(
      public readonly name: string,
      private _status: HealthStatus = 'healthy',
      private _delay: number = 0
    ) {
      super()
    }

    setStatus(status: HealthStatus) {
      this._status = status
    }

    async check(): Promise<CheckResult> {
      if (this._delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, this._delay))
      }
      switch (this._status) {
        case 'healthy':
          return this.healthy()
        case 'degraded':
          return this.degraded()
        case 'unhealthy':
          return this.unhealthy()
      }
    }
  }

  let manager: HealthManager

  beforeEach(() => {
    manager = new HealthManager()
  })

  describe('register', () => {
    it('should register a health check', () => {
      const check = new SimpleCheck('test')
      manager.register(check)

      expect(manager.getCheckNames()).toContain('test')
    })

    it('should register multiple checks', () => {
      manager.register(new SimpleCheck('check1'))
      manager.register(new SimpleCheck('check2'))

      expect(manager.getCheckNames()).toEqual(['check1', 'check2'])
    })

    it('should allow chaining', () => {
      const result = manager
        .register(new SimpleCheck('check1'))
        .register(new SimpleCheck('check2'))

      expect(result).toBe(manager)
    })
  })

  describe('unregister', () => {
    it('should unregister a check', () => {
      manager.register(new SimpleCheck('test'))
      manager.unregister('test')

      expect(manager.getCheckNames()).not.toContain('test')
    })
  })

  describe('check', () => {
    it('should run all checks', async () => {
      manager.register(new SimpleCheck('check1'))
      manager.register(new SimpleCheck('check2'))

      const report = await manager.check()

      expect(report.checks).toHaveLength(2)
      expect(report.checks.map((c) => c.name).sort()).toEqual(['check1', 'check2'])
    })

    it('should return healthy when all checks pass', async () => {
      manager.register(new SimpleCheck('check1', 'healthy'))
      manager.register(new SimpleCheck('check2', 'healthy'))

      const report = await manager.check()

      expect(report.status).toBe('healthy')
    })

    it('should return degraded when non-critical check fails', async () => {
      manager.register(new SimpleCheck('check1', 'healthy'))
      manager.register(new SimpleCheck('check2', 'unhealthy'))

      const report = await manager.check()

      expect(report.status).toBe('degraded')
    })

    it('should return unhealthy when critical check fails', async () => {
      manager.register(new SimpleCheck('check1', 'healthy'))
      manager.register(new SimpleCheck('check2', 'unhealthy'), { critical: true })

      const report = await manager.check()

      expect(report.status).toBe('unhealthy')
    })

    it('should return degraded when any check is degraded', async () => {
      manager.register(new SimpleCheck('check1', 'healthy'))
      manager.register(new SimpleCheck('check2', 'degraded'))

      const report = await manager.check()

      expect(report.status).toBe('degraded')
    })

    it('should include timestamp', async () => {
      manager.register(new SimpleCheck('test'))

      const before = new Date()
      const report = await manager.check()
      const after = new Date()

      expect(report.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(report.timestamp.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('should measure duration', async () => {
      manager.register(new SimpleCheck('slow', 'healthy', 50))

      const report = await manager.check()

      expect(report.checks[0].duration).toBeGreaterThanOrEqual(40)
    })

    it('should handle timeout', async () => {
      manager.register(new SimpleCheck('timeout', 'healthy', 200), { timeout: 50 })

      const report = await manager.check()

      expect(report.checks[0].status).toBe('unhealthy')
      expect(report.checks[0].message).toContain('timed out')
    })

    it('should handle check errors', async () => {
      class ErrorCheck extends HealthCheck {
        readonly name = 'error'
        async check(): Promise<CheckResult> {
          throw new Error('Check failed')
        }
      }

      manager.register(new ErrorCheck())

      const report = await manager.check()

      expect(report.checks[0].status).toBe('unhealthy')
      expect(report.checks[0].message).toBe('Check failed')
    })
  })

  describe('checkOnly', () => {
    it('should run only specified checks', async () => {
      manager.register(new SimpleCheck('check1'))
      manager.register(new SimpleCheck('check2'))
      manager.register(new SimpleCheck('check3'))

      const report = await manager.checkOnly(['check1', 'check3'])

      expect(report.checks).toHaveLength(2)
      expect(report.checks.map((c) => c.name).sort()).toEqual(['check1', 'check3'])
    })

    it('should ignore non-existent checks', async () => {
      manager.register(new SimpleCheck('check1'))

      const report = await manager.checkOnly(['check1', 'nonexistent'])

      expect(report.checks).toHaveLength(1)
    })
  })

  describe('getCheck', () => {
    it('should get a specific check result', async () => {
      manager.register(new SimpleCheck('test', 'healthy'))

      const result = await manager.getCheck('test')

      expect(result).not.toBeNull()
      expect(result!.name).toBe('test')
      expect(result!.status).toBe('healthy')
    })

    it('should return null for non-existent check', async () => {
      const result = await manager.getCheck('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('middleware', () => {
    // Driven through a real router rather than a hand-built Context double: the
    // bug these guard is that a handler which returns undefined without
    // finalizing yields an empty response, and only a real router exhibits that.
    // A double mirroring the `res` setter would stay green even if the router
    // stopped honouring it.
    async function callHealth(middleware: ReturnType<HealthManager['middleware']>) {
      const app = new Hono()
      app.get('/health', middleware as never)
      return app.request('/health')
    }

    it('should create middleware that runs all checks', async () => {
      manager.register(new SimpleCheck('test', 'healthy'))

      const response = await callHealth(manager.middleware())

      // Without finalization this is an empty 204 with no body at all.
      expect(response.status).toBe(200)
      expect((await response.json()).status).toBe('healthy')
    })

    it('should return 503 for unhealthy', async () => {
      manager.register(new SimpleCheck('test', 'unhealthy'), { critical: true })

      const response = await callHealth(manager.middleware())

      expect(response.status).toBe(503)
      expect((await response.json()).status).toBe('unhealthy')
    })

    it('should support detailed option', async () => {
      manager.register(new SimpleCheck('test'))

      const response = await callHealth(manager.middleware({ detailed: false }))

      expect((await response.json()).checks).toBeUndefined()
    })

    it('should support checks option', async () => {
      manager.register(new SimpleCheck('check1'))
      manager.register(new SimpleCheck('check2'))

      const response = await callHealth(manager.middleware({ checks: ['check1'] }))

      const body = await response.json()
      expect(body.checks).toHaveLength(1)
      expect(body.checks[0].name).toBe('check1')
    })
  })
})

describe('createHealthManager', () => {
  it('should create a new HealthManager', () => {
    const manager = createHealthManager()

    expect(manager).toBeInstanceOf(HealthManager)
  })
})

// ============================================================
// DatabaseCheck Tests
// ============================================================

describe('DatabaseCheck', () => {
  it('should return healthy when query succeeds', async () => {
    const db = {
      query: mock(() => Promise.resolve([{ '1': 1 }])),
    }

    const check = new DatabaseCheck(db)
    const result = await check.check()

    expect(result.status).toBe('healthy')
    expect(db.query).toHaveBeenCalledWith('SELECT 1')
  })

  it('should return unhealthy when query fails', async () => {
    const db = {
      query: mock(() => Promise.reject(new Error('Connection refused'))),
    }

    const check = new DatabaseCheck(db)
    const result = await check.check()

    expect(result.status).toBe('unhealthy')
    expect(result.message).toBe('Connection refused')
  })

  it('should use custom name', async () => {
    const db = { query: mock(() => Promise.resolve()) }

    const check = new DatabaseCheck(db, { name: 'postgres' })

    expect(check.name).toBe('postgres')
  })

  it('should use custom query', async () => {
    const db = { query: mock(() => Promise.resolve()) }

    const check = new DatabaseCheck(db, { query: 'SELECT NOW()' })
    await check.check()

    expect(db.query).toHaveBeenCalledWith('SELECT NOW()')
  })
})

// ============================================================
// RedisCheck Tests
// ============================================================

describe('RedisCheck', () => {
  it('should return healthy when ping returns PONG', async () => {
    const redis = {
      ping: mock(() => Promise.resolve('PONG')),
    }

    const check = new RedisCheck(redis)
    const result = await check.check()

    expect(result.status).toBe('healthy')
    expect(redis.ping).toHaveBeenCalled()
  })

  it('should return degraded when ping returns unexpected value', async () => {
    const redis = {
      ping: mock(() => Promise.resolve('OK')),
    }

    const check = new RedisCheck(redis)
    const result = await check.check()

    expect(result.status).toBe('degraded')
    expect(result.message).toContain('OK')
  })

  it('should return unhealthy when ping fails', async () => {
    const redis = {
      ping: mock(() => Promise.reject(new Error('Connection refused'))),
    }

    const check = new RedisCheck(redis)
    const result = await check.check()

    expect(result.status).toBe('unhealthy')
    expect(result.message).toBe('Connection refused')
  })

  it('should use custom name', async () => {
    const redis = { ping: mock(() => Promise.resolve('PONG')) }

    const check = new RedisCheck(redis, { name: 'redis-session' })

    expect(check.name).toBe('redis-session')
  })
})

// ============================================================
// CacheCheck Tests
// ============================================================

describe('CacheCheck', () => {
  it('should return healthy when cache operations succeed', async () => {
    let stored: unknown = null
    const cache = {
      get: mock(() => Promise.resolve(stored)),
      put: mock((key: string, value: unknown) => {
        stored = value
        return Promise.resolve()
      }),
      forget: mock(() => Promise.resolve(true)),
    }

    const check = new CacheCheck(cache as unknown as CacheStoreInterface)
    const result = await check.check()

    expect(result.status).toBe('healthy')
    expect(cache.put).toHaveBeenCalled()
    expect(cache.get).toHaveBeenCalled()
    expect(cache.forget).toHaveBeenCalled()
  })

  it('should return degraded when read/write mismatch', async () => {
    const cache = {
      get: mock(() => Promise.resolve('wrong_value')),
      put: mock(() => Promise.resolve()),
      forget: mock(() => Promise.resolve(true)),
    }

    const check = new CacheCheck(cache as unknown as CacheStoreInterface)
    const result = await check.check()

    expect(result.status).toBe('degraded')
    expect(result.message).toContain('mismatch')
  })

  it('should return unhealthy when operation fails', async () => {
    const cache = {
      get: mock(() => Promise.reject(new Error('Cache error'))),
      put: mock(() => Promise.resolve()),
      forget: mock(() => Promise.resolve(true)),
    }

    const check = new CacheCheck(cache as unknown as CacheStoreInterface)
    const result = await check.check()

    expect(result.status).toBe('unhealthy')
    expect(result.message).toBe('Cache error')
  })

  it('should use custom test key', async () => {
    let usedKey: string | null = null
    const cache = {
      get: mock((key: string) => {
        usedKey = key
        return Promise.resolve('test')
      }),
      put: mock((key: string, value: unknown) => {
        usedKey = key
        return Promise.resolve()
      }),
      forget: mock(() => Promise.resolve(true)),
    }

    const check = new CacheCheck(cache as unknown as CacheStoreInterface, { testKey: 'custom_key' })
    await check.check()

    expect(usedKey ?? '').toBe('custom_key')
  })
})

// ============================================================
// StorageCheck Tests
// ============================================================

describe('StorageCheck', () => {
  it('should return healthy when storage operations succeed', async () => {
    let stored: string | null = null
    const storage = {
      put: mock((path: string, contents: string) => {
        stored = contents
        return Promise.resolve()
      }),
      get: mock(() => Promise.resolve(stored ? Buffer.from(stored) : null)),
      delete: mock(() => Promise.resolve(true)),
    }

    const check = new StorageCheck(storage)
    const result = await check.check()

    expect(result.status).toBe('healthy')
    expect(storage.put).toHaveBeenCalled()
    expect(storage.get).toHaveBeenCalled()
    expect(storage.delete).toHaveBeenCalled()
  })

  it('should return degraded when read/write mismatch', async () => {
    const storage = {
      put: mock(() => Promise.resolve()),
      get: mock(() => Promise.resolve(Buffer.from('wrong'))),
      delete: mock(() => Promise.resolve(true)),
    }

    const check = new StorageCheck(storage)
    const result = await check.check()

    expect(result.status).toBe('degraded')
    expect(result.message).toContain('mismatch')
  })

  it('should return unhealthy when operation fails', async () => {
    const storage = {
      put: mock(() => Promise.reject(new Error('Storage error'))),
      get: mock(() => Promise.resolve(null)),
      delete: mock(() => Promise.resolve(true)),
    }

    const check = new StorageCheck(storage)
    const result = await check.check()

    expect(result.status).toBe('unhealthy')
    expect(result.message).toBe('Storage error')
  })
})

// ============================================================
// MemoryCheck Tests
// ============================================================

describe('MemoryCheck', () => {
  // Both thresholds pinned: the defaults (512/1024) compare against this test
  // process's own heap, which crosses 1 GB mid-suite under `--isolate` on a
  // single process — the unhealthy branch would fire and flip the verdict.
  it('should return healthy when memory is below threshold', async () => {
    const check = new MemoryCheck({ thresholdMb: 10000, criticalThresholdMb: 20000 })
    const result = await check.check()

    expect(result.status).toBe('healthy')
    expect(result.meta).toHaveProperty('usedMb')
    expect(result.meta).toHaveProperty('totalMb')
    expect(result.meta).toHaveProperty('rssMb')
  })

  it('should return degraded when memory exceeds threshold', async () => {
    const check = new MemoryCheck({ thresholdMb: 0, criticalThresholdMb: 20000 })
    const result = await check.check()

    expect(result.status).toBe('degraded')
    expect(result.message).toContain('elevated')
  })

  it('should return unhealthy when memory exceeds critical threshold', async () => {
    const check = new MemoryCheck({ thresholdMb: 0, criticalThresholdMb: 0 })
    const result = await check.check()

    expect(result.status).toBe('unhealthy')
    expect(result.message).toContain('critical')
  })

  it('should include threshold in meta', async () => {
    const check = new MemoryCheck({ thresholdMb: 512, criticalThresholdMb: 1024 })
    const result = await check.check()

    expect(result.meta?.thresholdMb).toBe(512)
    expect(result.meta?.criticalThresholdMb).toBe(1024)
  })

  it('should use custom name', async () => {
    const check = new MemoryCheck({ name: 'heap-memory' })

    expect(check.name).toBe('heap-memory')
  })
})

// ============================================================
// CustomCheck Tests
// ============================================================

describe('CustomCheck', () => {
  it('should call the callback', async () => {
    const callback = mock(() => Promise.resolve({ status: 'healthy' as const }))

    const check = new CustomCheck('custom', callback)
    await check.check()

    expect(callback).toHaveBeenCalled()
  })

  it('should return healthy from callback', async () => {
    const check = new CustomCheck('custom', async () => ({
      status: 'healthy',
      message: 'All good',
    }))

    const result = await check.check()

    expect(result.status).toBe('healthy')
    expect(result.message).toBe('All good')
  })

  it('should return degraded from callback', async () => {
    const check = new CustomCheck('custom', async () => ({
      status: 'degraded',
      message: 'Slow',
    }))

    const result = await check.check()

    expect(result.status).toBe('degraded')
    expect(result.message).toBe('Slow')
  })

  it('should return unhealthy from callback', async () => {
    const check = new CustomCheck('custom', async () => ({
      status: 'unhealthy',
      message: 'Failed',
      meta: { error: 'timeout' },
    }))

    const result = await check.check()

    expect(result.status).toBe('unhealthy')
    expect(result.message).toBe('Failed')
    expect(result.meta).toEqual({ error: 'timeout' })
  })

  it('should handle callback errors', async () => {
    const check = new CustomCheck('custom', async () => {
      throw new Error('Callback failed')
    })

    const result = await check.check()

    expect(result.status).toBe('unhealthy')
    expect(result.message).toBe('Callback failed')
  })
})

describe('customCheck helper', () => {
  it('should create a CustomCheck', async () => {
    const check = customCheck('external-api', async () => ({
      status: 'healthy',
      message: 'API responding',
    }))

    expect(check).toBeInstanceOf(CustomCheck)
    expect(check.name).toBe('external-api')

    const result = await check.check()
    expect(result.status).toBe('healthy')
  })
})

import { beforeEach, describe, expect, test } from 'bun:test'
import { captureWorkersEnv, getWorkersEnv, resetWorkersEnv, WORKERS_ENV_SLOT } from './env'

interface TestEnv {
  DB: string
}

describe('captureWorkersEnv / getWorkersEnv / resetWorkersEnv', () => {
  beforeEach(() => {
    resetWorkersEnv()
  })

  test('should throw when getWorkersEnv is called before the first capture', () => {
    expect(() => getWorkersEnv()).toThrow(
      'getWorkersEnv() was called before the first request captured the Workers env',
    )
  })

  test('should return the captured env after captureWorkersEnv is called', () => {
    const env = { DB: 'first-db' }

    captureWorkersEnv(env)

    expect(getWorkersEnv<TestEnv>()).toBe(env)
  })

  test('should ignore later captureWorkersEnv calls (write-once)', () => {
    const first = { DB: 'first-db' }
    const second = { DB: 'second-db' }

    captureWorkersEnv(first)
    captureWorkersEnv(second)

    // Ignored rather than refused, and measured rather than assumed: on workerd
    // a Worker entrypoint and a Durable Object of one deployment carry
    // different `env` objects, so a throw here would break the two-entrypoint
    // topology of RFC 0017 §6 instead of catching a second deployment.
    expect(getWorkersEnv<TestEnv>()).toBe(first)
  })

  test('should allow recapture after resetWorkersEnv', () => {
    const first = { DB: 'first-db' }
    const second = { DB: 'second-db' }

    captureWorkersEnv(first)
    resetWorkersEnv()
    captureWorkersEnv(second)

    expect(getWorkersEnv<TestEnv>()).toBe(second)
  })

  test('should throw again after resetWorkersEnv clears the holder', () => {
    captureWorkersEnv({ DB: 'first-db' })
    resetWorkersEnv()

    expect(() => getWorkersEnv()).toThrow()
  })
})

describe('the env slot @guren/orm reads', () => {
  test('should keep the captured env under the registry symbol createD1Database({ binding: name }) resolves through', () => {
    resetWorkersEnv()
    captureWorkersEnv({ DB: 'binding' })
    try {
      expect(WORKERS_ENV_SLOT.description).toBe('guren.workersEnv')
      expect(Symbol.keyFor(WORKERS_ENV_SLOT)).toBe('guren.workersEnv')
      expect((globalThis as typeof globalThis & { [WORKERS_ENV_SLOT]?: unknown })[WORKERS_ENV_SLOT]).toEqual({ env: { DB: 'binding' } })
    } finally {
      resetWorkersEnv()
    }
  })
})

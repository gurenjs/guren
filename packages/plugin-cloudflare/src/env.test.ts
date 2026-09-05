import { beforeEach, describe, expect, test } from 'bun:test'
import { captureWorkersEnv, getWorkersEnv, resetWorkersEnv } from './env'

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

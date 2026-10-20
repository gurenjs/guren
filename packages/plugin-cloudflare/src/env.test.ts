import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { captureWorkersEnv, getWorkersEnv, isWorkersRuntime, resetWorkersEnv } from './env'

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

describe('isWorkersRuntime under introspection (RFC 0035 §2.1)', () => {
  const saved = { introspect: process.env.GUREN_INTROSPECT, target: process.env.GUREN_INTROSPECT_TARGET }

  afterEach(() => {
    for (const [key, value] of [['GUREN_INTROSPECT', saved.introspect], ['GUREN_INTROSPECT_TARGET', saved.target]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('should take the Workers branch only inside an introspection run targeting Cloudflare', () => {
    process.env.GUREN_INTROSPECT = '1'
    process.env.GUREN_INTROSPECT_TARGET = 'cloudflare'
    expect(isWorkersRuntime()).toBe(true)

    // A target left exported in a shell must not move `bun run dev` onto the Workers branch.
    delete process.env.GUREN_INTROSPECT
    expect(isWorkersRuntime()).toBe(false)

    process.env.GUREN_INTROSPECT = '1'
    process.env.GUREN_INTROSPECT_TARGET = 'lambda'
    expect(isWorkersRuntime()).toBe(false)
  })
})

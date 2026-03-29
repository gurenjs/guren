import { describe, expect, it } from 'bun:test'
import { ensureErrorStackTracePolyfill } from '../../src/support/error-polyfill'

describe('ensureErrorStackTracePolyfill', () => {
  it('adds stack traces to non-Error targets', () => {
    const original = (Error as typeof Error & { captureStackTrace?: typeof Error.captureStackTrace }).captureStackTrace

    ensureErrorStackTracePolyfill()

    const target: { stack?: string } = {}
    Error.captureStackTrace?.(target)

    expect(target.stack).toBeDefined()

    if (original) {
      Error.captureStackTrace = original
    } else {
      delete (Error as any).captureStackTrace
    }
  })
})

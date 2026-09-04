import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { FailedJobReporter, type FailedJobInfo } from './FailedJobReporter'

function createFailedJobInfo(overrides: Partial<FailedJobInfo> = {}): FailedJobInfo {
  return {
    jobName: 'SendEmailJob',
    queue: 'default',
    attempt: 1,
    maxAttempts: 3,
    willRetry: true,
    error: new Error('Connection refused'),
    failedAt: new Date('2026-01-15T10:00:00Z'),
    ...overrides,
  }
}

describe('FailedJobReporter', () => {
  let originalConsoleError: typeof console.error

  beforeEach(() => {
    originalConsoleError = console.error
  })

  afterEach(() => {
    console.error = originalConsoleError
  })

  test('should log to console.error by default', async () => {
    const logs: string[] = []
    console.error = (...args: unknown[]) => {
      logs.push(String(args[0]))
    }

    const reporter = new FailedJobReporter()
    const info = createFailedJobInfo()
    await reporter.report(info)

    expect(logs).toHaveLength(1)
    const parsed = JSON.parse(logs[0]!)
    expect(parsed.level).toBe('error')
    expect(parsed.msg).toBe('Job failed: SendEmailJob')
    expect(parsed.job).toBe('SendEmailJob')
    expect(parsed.queue).toBe('default')
    expect(parsed.attempt).toBe(1)
    expect(parsed.maxAttempts).toBe(3)
    expect(parsed.willRetry).toBe(true)
    expect(parsed.error).toBe('Connection refused')
    expect(parsed.failedAt).toBe('2026-01-15T10:00:00.000Z')
  })

  test('should call custom handlers', async () => {
    console.error = () => {}

    const reporter = new FailedJobReporter()
    const received: FailedJobInfo[] = []

    reporter.onFailure((info) => {
      received.push(info)
    })

    const info = createFailedJobInfo({ jobName: 'ProcessPaymentJob' })
    await reporter.report(info)

    expect(received).toHaveLength(1)
    expect(received[0]!.jobName).toBe('ProcessPaymentJob')
  })

  test('should call multiple custom handlers in order', async () => {
    console.error = () => {}

    const reporter = new FailedJobReporter()
    const callOrder: number[] = []

    reporter.onFailure(() => { callOrder.push(1) })
    reporter.onFailure(() => { callOrder.push(2) })

    await reporter.report(createFailedJobInfo())

    expect(callOrder).toEqual([1, 2])
  })

  test('should not propagate handler errors', async () => {
    console.error = () => {}

    const reporter = new FailedJobReporter()
    const called: boolean[] = []

    reporter.onFailure(() => {
      throw new Error('Handler exploded')
    })
    reporter.onFailure(() => {
      called.push(true)
    })

    await reporter.report(createFailedJobInfo())

    expect(called).toHaveLength(1)
  })

  test('should not propagate async handler errors', async () => {
    console.error = () => {}

    const reporter = new FailedJobReporter()
    const called: boolean[] = []

    reporter.onFailure(async () => {
      throw new Error('Async handler exploded')
    })
    reporter.onFailure(() => {
      called.push(true)
    })

    await reporter.report(createFailedJobInfo())

    expect(called).toHaveLength(1)
  })

  test('should support async custom handlers', async () => {
    console.error = () => {}

    const reporter = new FailedJobReporter()
    let asyncResult: string | undefined

    reporter.onFailure(async (info) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      asyncResult = info.jobName
    })

    await reporter.report(createFailedJobInfo({ jobName: 'AsyncTestJob' }))

    expect(asyncResult).toBe('AsyncTestJob')
  })

  test('should support fluent chaining via onFailure', () => {
    const reporter = new FailedJobReporter()

    const result = reporter
      .onFailure(() => {})
      .onFailure(() => {})

    expect(result).toBe(reporter)
  })
})

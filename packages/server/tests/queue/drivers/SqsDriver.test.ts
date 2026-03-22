import { describe, test, expect, beforeEach } from 'bun:test'

import { SqsDriver, type SqsAdapter } from '../../../src/queue/drivers/SqsDriver'
import type { QueuedJob } from '../../../src/queue/types'

interface MockCall {
  method: string
  params: unknown
}

function createMockAdapter(): SqsAdapter & { calls: MockCall[] } {
  const calls: MockCall[] = []
  return {
    calls,
    async sendMessage(params) {
      calls.push({ method: 'sendMessage', params })
    },
    async receiveMessage(params) {
      calls.push({ method: 'receiveMessage', params })
      return null
    },
    async changeMessageVisibility(params) {
      calls.push({ method: 'changeMessageVisibility', params })
    },
    async getApproximateMessageCount(queueUrl) {
      calls.push({ method: 'getApproximateMessageCount', params: queueUrl })
      return 5
    },
  }
}

function createTestJob(overrides: Partial<QueuedJob> = {}): QueuedJob {
  return {
    id: 'job-1',
    name: 'TestJob',
    payload: { foo: 'bar' },
    queue: 'default',
    attempts: 0,
    maxAttempts: 3,
    availableAt: new Date(),
    createdAt: new Date(),
    reservedAt: null,
    ...overrides,
  }
}

describe('SqsDriver', () => {
  let adapter: ReturnType<typeof createMockAdapter>
  let driver: SqsDriver

  beforeEach(() => {
    adapter = createMockAdapter()
    driver = new SqsDriver(adapter, {
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue',
    })
  })

  test('should push a job via sendMessage', async () => {
    const job = createTestJob()
    await driver.push(job)

    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0].method).toBe('sendMessage')
    const params = adapter.calls[0].params as any
    expect(params.queueUrl).toBe('https://sqs.us-east-1.amazonaws.com/123456789012/my-queue')

    const body = JSON.parse(params.messageBody)
    expect(body.name).toBe('TestJob')
    expect(body.payload).toEqual({ foo: 'bar' })
  })

  test('should calculate delay from availableAt', async () => {
    const futureDate = new Date(Date.now() + 30000)
    const job = createTestJob({ availableAt: futureDate })
    await driver.push(job)

    const params = adapter.calls[0].params as any
    expect(params.delaySeconds).toBeGreaterThanOrEqual(29)
    expect(params.delaySeconds).toBeLessThanOrEqual(30)
  })

  test('should cap delay at 900 seconds', async () => {
    const farFuture = new Date(Date.now() + 2000000)
    const job = createTestJob({ availableAt: farFuture })
    await driver.push(job)

    const params = adapter.calls[0].params as any
    expect(params.delaySeconds).toBe(900)
  })

  test('should resolve queue-specific URLs', async () => {
    const driverWithUrls = new SqsDriver(adapter, {
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/default',
      queueUrls: {
        emails: 'https://sqs.us-east-1.amazonaws.com/123/emails',
      },
    })

    const job = createTestJob({ queue: 'emails' })
    await driverWithUrls.push(job)

    const params = adapter.calls[0].params as any
    expect(params.queueUrl).toBe('https://sqs.us-east-1.amazonaws.com/123/emails')
  })

  test('should fall back to primary URL for unknown queues', async () => {
    const job = createTestJob({ queue: 'unknown' })
    await driver.push(job)

    const params = adapter.calls[0].params as any
    expect(params.queueUrl).toBe('https://sqs.us-east-1.amazonaws.com/123456789012/my-queue')
  })

  test('should return null from pop when no messages', async () => {
    const result = await driver.pop('default')
    expect(result).toBeNull()
  })

  test('should get approximate queue size', async () => {
    const size = await driver.size('default')
    expect(size).toBe(5)
  })

  test('should track and retrieve failed jobs', async () => {
    const job = createTestJob()
    await driver.fail(job, new Error('something broke'))

    const failed = await driver.getFailedJobs()
    expect(failed).toHaveLength(1)
    expect(failed[0].error).toBe('something broke')
    expect(failed[0].name).toBe('TestJob')
  })

  test('should retry a failed job by re-pushing', async () => {
    const job = createTestJob()
    await driver.fail(job, new Error('temporary'))

    await driver.retryFailedJob('job-1')

    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0].method).toBe('sendMessage')

    const failed = await driver.getFailedJobs()
    expect(failed).toHaveLength(0)
  })

  test('should throw when retrying non-existent failed job', async () => {
    expect(driver.retryFailedJob('nonexistent')).rejects.toThrow('Failed job not found')
  })

  test('should clear all state', async () => {
    const job = createTestJob()
    await driver.fail(job, new Error('test'))
    await driver.clear()

    const failed = await driver.getFailedJobs()
    expect(failed).toHaveLength(0)
  })

  test('should include FIFO params when messageGroupId is set', async () => {
    const fifoDriver = new SqsDriver(adapter, {
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/queue.fifo',
      messageGroupId: 'my-group',
    })

    const job = createTestJob()
    await fifoDriver.push(job)

    const params = adapter.calls[0].params as any
    expect(params.messageGroupId).toBe('my-group')
    expect(params.messageDeduplicationId).toBe('job-1')
  })

  test('should pop job when adapter returns message', async () => {
    const testJob = createTestJob()
    const adapterWithMessage = createMockAdapter()
    adapterWithMessage.receiveMessage = async () => ({
      body: JSON.stringify(testJob),
      receiptHandle: 'receipt-123',
    })

    const driverWithMessage = new SqsDriver(adapterWithMessage, {
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/queue',
    })

    const result = await driverWithMessage.pop('default')
    expect(result).not.toBeNull()
    expect(result!.name).toBe('TestJob')
    expect(result!.reservedAt).toBeInstanceOf(Date)
  })
})

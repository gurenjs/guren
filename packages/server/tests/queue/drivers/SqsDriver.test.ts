import { describe, test, expect, beforeEach } from 'bun:test'

import { SqsDriver, type SqsAdapter } from '../../../src/queue/drivers/SqsDriver'
import { resetWarnOnce } from '../../../src/support/warn-once'
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
    async deleteMessage(params) {
      calls.push({ method: 'deleteMessage', params })
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
    await expect(driver.retryFailedJob('nonexistent')).rejects.toThrow('Failed job not found')
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

  test('should delete the popped message when a job completes', async () => {
    const testJob = createTestJob()
    adapter.receiveMessage = async () => ({
      body: JSON.stringify(testJob),
      receiptHandle: 'receipt-123',
    })

    await driver.pop('default')
    await driver.delete('job-1')

    const deletes = adapter.calls.filter((call) => call.method === 'deleteMessage')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].params).toEqual({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue',
      receiptHandle: 'receipt-123',
    })

    await driver.delete('job-1')
    expect(adapter.calls.filter((call) => call.method === 'deleteMessage')).toHaveLength(1)
  })

  test('should delete the popped message from the queue it was received on', async () => {
    const driverWithUrls = new SqsDriver(adapter, {
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/default',
      queueUrls: { emails: 'https://sqs.us-east-1.amazonaws.com/123/emails' },
    })
    adapter.receiveMessage = async () => ({
      body: JSON.stringify(createTestJob({ queue: 'default' })),
      receiptHandle: 'receipt-emails',
    })

    await driverWithUrls.pop('emails')
    await driverWithUrls.delete('job-1')

    const deletes = adapter.calls.filter((call) => call.method === 'deleteMessage')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].params).toEqual({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/emails',
      receiptHandle: 'receipt-emails',
    })
  })

  test('should extend visibility on the queue the message was received on', async () => {
    const driverWithUrls = new SqsDriver(adapter, {
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/default',
      queueUrls: { emails: 'https://sqs.us-east-1.amazonaws.com/123/emails' },
    })
    adapter.receiveMessage = async () => ({
      body: JSON.stringify(createTestJob({ queue: 'default' })),
      receiptHandle: 'receipt-emails',
    })

    const popped = await driverWithUrls.pop('emails')
    await driverWithUrls.release(popped!, 5000)

    const visibility = adapter.calls.filter((call) => call.method === 'changeMessageVisibility')
    expect(visibility).toHaveLength(1)
    expect(visibility[0].params).toEqual({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/emails',
      receiptHandle: 'receipt-emails',
      visibilityTimeout: 5,
    })
  })

  test('should delete the popped message when a job fails permanently', async () => {
    const testJob = createTestJob()
    adapter.receiveMessage = async () => ({
      body: JSON.stringify(testJob),
      receiptHandle: 'receipt-456',
    })

    const popped = await driver.pop('default')
    await driver.fail(popped!, new Error('permanent'))

    const deletes = adapter.calls.filter((call) => call.method === 'deleteMessage')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].params).toEqual({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue',
      receiptHandle: 'receipt-456',
    })
    expect(await driver.getFailedJobs()).toHaveLength(1)
  })

  test('should not delete a message for a job it never popped', async () => {
    await driver.fail(createTestJob(), new Error('never reserved'))
    await driver.delete('job-1')

    expect(adapter.calls.filter((call) => call.method === 'deleteMessage')).toHaveLength(0)
  })

  test('should warn once for an adapter without deleteMessage', async () => {
    const legacyAdapter = createMockAdapter()
    delete (legacyAdapter as { deleteMessage?: unknown }).deleteMessage
    legacyAdapter.receiveMessage = async () => ({
      body: JSON.stringify(createTestJob({ id: crypto.randomUUID() })),
      receiptHandle: 'receipt-legacy',
    })
    const legacyDriver = new SqsDriver(legacyAdapter, {
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/queue',
    })

    resetWarnOnce()
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }

    try {
      const first = await legacyDriver.pop('default')
      await legacyDriver.delete(first!.id)
      const second = await legacyDriver.pop('default')
      await legacyDriver.delete(second!.id)
    } finally {
      console.warn = originalWarn
    }

    expect(warnings).toHaveLength(1)
    expect(String(warnings[0][0])).toContain('deleteMessage')
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

import { describe, test, expect, beforeEach } from 'bun:test'

import { SqsDriver, type SqsAdapter } from '../../../src/queue/drivers/SqsDriver'
import type { QueuedJob } from '../../../src/queue/types'
import { resetWarnOnce } from '../../../src/support/warn-once'
import { captureWarnings } from '../../support/warnings'

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

function stubMessages(
  adapter: SqsAdapter,
  receiptHandle: string,
  nextJob: () => QueuedJob = createTestJob,
): void {
  adapter.receiveMessage = async () => ({ body: JSON.stringify(nextJob()), receiptHandle })
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
    stubMessages(adapter, 'receipt-123')

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
    stubMessages(adapter, 'receipt-emails', () => createTestJob({ queue: 'default' }))

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
    stubMessages(adapter, 'receipt-emails', () => createTestJob({ queue: 'default' }))

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
    stubMessages(adapter, 'receipt-456')

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

  test('should still record a failed job when the message cannot be deleted', async () => {
    stubMessages(adapter, 'receipt-789')
    adapter.deleteMessage = async () => {
      throw new Error('RequestThrottled')
    }

    const popped = await driver.pop('default')

    const errors: string[] = []
    const originalError = console.error
    console.error = (message: string) => errors.push(message)
    try {
      await driver.fail(popped!, new Error('permanent'))
    } finally {
      console.error = originalError
    }

    expect(await driver.getFailedJobs()).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('RequestThrottled')
  })

  test('should not delete a message for a job it never popped', async () => {
    await driver.fail(createTestJob(), new Error('never reserved'))
    await driver.delete('job-1')

    expect(adapter.calls.filter((call) => call.method === 'deleteMessage')).toHaveLength(0)
  })

  test('should warn once for an adapter without deleteMessage', async () => {
    const legacyAdapter = createMockAdapter()
    delete (legacyAdapter as { deleteMessage?: unknown }).deleteMessage
    stubMessages(legacyAdapter, 'receipt-legacy', () => createTestJob({ id: crypto.randomUUID() }))
    const legacyDriver = new SqsDriver(legacyAdapter, {
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/queue',
    })

    resetWarnOnce()
    const warnings = await captureWarnings(async () => {
      for (let i = 0; i < 2; i++) {
        const job = await legacyDriver.pop('default')
        await legacyDriver.delete(job!.id)
      }
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('deleteMessage')
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

  describe('reservation renewal', () => {
    async function popWithReceipt(adapterInstance: ReturnType<typeof createMockAdapter>, options: { visibilityTimeout?: number } = {}) {
      adapterInstance.receiveMessage = async () => ({ body: JSON.stringify(createTestJob()), receiptHandle: 'receipt-123' })
      const instance = new SqsDriver(adapterInstance, { queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/queue', ...options })
      return { instance, job: (await instance.pop('default'))! }
    }

    test('should renew a third of the visibility timeout at a time', async () => {
      expect(driver.heartbeatInterval).toBe(10_000)
      expect(new SqsDriver(adapter, { queueUrl: 'https://q', visibilityTimeout: 120 }).heartbeatInterval).toBe(40_000)
    })

    test('should re-apply the visibility timeout to the in-flight receipt handle', async () => {
      const { instance, job } = await popWithReceipt(adapter, { visibilityTimeout: 90 })
      expect(await instance.extendReservation(job)).toBe(true)
      expect(adapter.calls.at(-1)).toEqual({
        method: 'changeMessageVisibility',
        params: { queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/queue', receiptHandle: 'receipt-123', visibilityTimeout: 90 },
      })
    })

    test('should report a reservation it no longer holds as lost', async () => {
      expect(await driver.extendReservation(createTestJob())).toBe(false)
      const { instance, job } = await popWithReceipt(adapter)
      adapter.changeMessageVisibility = async () => false
      expect(await instance.extendReservation(job)).toBe(false)
    })

    test('should treat an adapter written before the boolean return as owning the receipt', async () => {
      const { instance, job } = await popWithReceipt(adapter)
      expect(await instance.extendReservation(job)).toBe(true)
    })

    test('should surface other adapter errors so the worker retries the renewal', async () => {
      const { instance, job } = await popWithReceipt(adapter)
      adapter.changeMessageVisibility = async () => { throw new Error('connection reset') }
      await expect(instance.extendReservation(job)).rejects.toThrow('connection reset')
    })
  })
})

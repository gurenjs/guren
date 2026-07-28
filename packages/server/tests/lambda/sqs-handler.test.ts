import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

import { createSqsHandler, type SqsEvent } from '../../src/lambda'
import { Job, registerJob, clearJobRegistry } from '../../src/queue/Job'

const handled: Array<{ value: number }> = []

class SuccessJob extends Job<{ value: number }> {
  async handle(payload: { value: number }): Promise<void> {
    // Simulate successful processing
    if (payload.value < 0) throw new Error('negative value')
    handled.push(payload)
  }
}

let failedCallPayload: unknown = null

class FailingJob extends Job<{ id: string }> {
  static maxAttempts = 1

  async handle(): Promise<void> {
    throw new Error('always fails')
  }

  async failed(payload: { id: string }): Promise<void> {
    failedCallPayload = payload
  }
}

function createSqsRecord(job: { name: string; payload: unknown; attempts?: number; maxAttempts?: number }, messageId: string) {
  return {
    messageId,
    receiptHandle: `receipt-${messageId}`,
    body: JSON.stringify({
      id: `job-${messageId}`,
      name: job.name,
      payload: job.payload,
      queue: 'default',
      attempts: job.attempts ?? 0,
      maxAttempts: job.maxAttempts ?? 3,
      availableAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      reservedAt: null,
    }),
    attributes: {},
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:my-queue',
    awsRegion: 'us-east-1',
  }
}

describe('createSqsHandler', () => {
  beforeEach(() => {
    clearJobRegistry()
    registerJob(SuccessJob)
    registerJob(FailingJob)
    failedCallPayload = null
    handled.length = 0
  })

  afterEach(() => {
    clearJobRegistry()
  })

  test('should process all records successfully', async () => {
    const handler = createSqsHandler()

    const event: SqsEvent = {
      Records: [
        createSqsRecord({ name: 'SuccessJob', payload: { value: 1 } }, 'msg-1'),
        createSqsRecord({ name: 'SuccessJob', payload: { value: 2 } }, 'msg-2'),
      ],
    }

    const result = await handler(event)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  test('should report partial batch failures', async () => {
    const handler = createSqsHandler()

    const event: SqsEvent = {
      Records: [
        createSqsRecord({ name: 'SuccessJob', payload: { value: 1 } }, 'msg-1'),
        createSqsRecord({ name: 'SuccessJob', payload: { value: -1 } }, 'msg-2'), // Will fail
        createSqsRecord({ name: 'SuccessJob', payload: { value: 3 } }, 'msg-3'),
      ],
    }

    const result = await handler(event)

    expect(result.batchItemFailures).toHaveLength(1)
    expect(result.batchItemFailures[0].itemIdentifier).toBe('msg-2')
    // The surviving records must actually reach the job with their payloads
    // intact — an empty batchItemFailures list alone is also what a handler
    // that silently resolved nothing would return.
    expect(handled).toEqual([{ value: 1 }, { value: 3 }])
  })

  test('should report failure for unknown job classes', async () => {
    const handler = createSqsHandler()

    const event: SqsEvent = {
      Records: [
        createSqsRecord({ name: 'NonExistentJob', payload: {} }, 'msg-1'),
      ],
    }

    const result = await handler(event)

    expect(result.batchItemFailures).toHaveLength(1)
    expect(result.batchItemFailures[0].itemIdentifier).toBe('msg-1')
  })

  test('should call failed handler when max attempts reached', async () => {
    const handler = createSqsHandler()

    const event: SqsEvent = {
      Records: [
        createSqsRecord({ name: 'FailingJob', payload: { id: 'test-123' }, attempts: 0, maxAttempts: 1 }, 'msg-1'),
      ],
    }

    const result = await handler(event)

    expect(result.batchItemFailures).toHaveLength(1)
    expect(failedCallPayload).toEqual({ id: 'test-123' })
  })

  test('should tolerate an empty batch', async () => {
    const handler = createSqsHandler()

    const result = await handler({ Records: [] })

    expect(result.batchItemFailures).toHaveLength(0)
  })

  test('should not call failed handler when retries remain', async () => {
    const handler = createSqsHandler()

    const event: SqsEvent = {
      Records: [
        createSqsRecord({ name: 'FailingJob', payload: { id: 'test-456' }, attempts: 0, maxAttempts: 5 }, 'msg-1'),
      ],
    }

    await handler(event)

    expect(failedCallPayload).toBeNull()
  })
})

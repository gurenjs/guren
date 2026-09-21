import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'

import { createSqsHandler, type SqsEvent, type SqsRecord } from '../../src/lambda'
import { Job, registerJob, clearJobRegistry } from '../../src/queue/Job'

const handled: Array<{ value: number }> = []

class SuccessJob extends Job<{ value: number }> {
  async handle(payload: { value: number }): Promise<void> {
    if (payload.value < 0) throw new Error('negative value')
    handled.push(payload)
  }
}

let failedCallPayload: unknown = null

const errorLogs: string[] = []
let errorSpy: ReturnType<typeof spyOn>

const FIFO_ARN = 'arn:aws:sqs:us-east-1:123456789012:jobs.fifo'

beforeEach(() => {
  clearJobRegistry()
  registerJob(SuccessJob)
  registerJob(FailingJob)
  failedCallPayload = null
  handled.length = 0
  errorLogs.length = 0
  errorSpy = spyOn(console, 'error').mockImplementation((message: string) => { errorLogs.push(String(message)) })
})

afterEach(() => {
  errorSpy.mockRestore()
  clearJobRegistry()
})

class FailingJob extends Job<{ id: string }> {
  static maxAttempts = 1

  async handle(): Promise<void> {
    throw new Error('always fails')
  }

  async failed(payload: { id: string }): Promise<void> {
    failedCallPayload = payload
  }
}

function createSqsRecord(job: { name: string; payload: unknown; attempts?: number; maxAttempts?: number }, messageId: string): SqsRecord {
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
    attributes: { ApproximateReceiveCount: '1' },
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:my-queue',
    awsRegion: 'us-east-1',
  }
}

describe('createSqsHandler', () => {
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
    // An empty batchItemFailures list is also what a handler that silently
    // resolved nothing would return, so pin what actually reached the job.
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

describe('SQS delivery semantics', () => {
  test('uses the receive count across invocations and stops handle at maxAttempts', async () => {
    let calls = 0
    const errors: string[] = []
    class DeliveryFailure extends Job {
      async handle() { calls++; throw new Error('original failure') }
      async failed(_payload: unknown, error: Error) { errors.push(error.message) }
    }
    registerJob(DeliveryFailure)
    for (let delivery = 1; delivery <= 5; delivery++) {
      const record = createSqsRecord({ name: 'DeliveryFailure', payload: {}, maxAttempts: 3 }, 'retry')
      record.attributes.ApproximateReceiveCount = String(delivery)
      // A fresh handler cannot rely on state from an earlier invocation.
      expect(await createSqsHandler()({ Records: [record] })).toEqual({
        batchItemFailures: [{ itemIdentifier: 'retry' }],
      })
      expect(errors).toHaveLength(delivery < 3 ? 0 : 1)
    }
    expect(calls).toBe(3)
    // Worker.handleFailedJob runs the hook once, with the error that spent the
    // last attempt; redeliveries past the budget must not run it again.
    expect(errors).toEqual(['original failure'])
  })

  test('skips handle and failed on a delivery past the budget', async () => {
    // What a FIFO record left unprocessed behind an earlier failure looks like:
    // its deliveries were spent elsewhere, so handle() never ran.
    const record = createSqsRecord({ name: 'FailingJob', payload: { id: 'starved' }, maxAttempts: 1 }, 'starved')
    record.attributes.ApproximateReceiveCount = '2'
    expect(await createSqsHandler()({ Records: [record] })).toEqual({
      batchItemFailures: [{ itemIdentifier: 'starved' }],
    })
    expect(failedCallPayload).toBeNull()
  })

  test('logs the reason for every record it reports', async () => {
    const records = [
      createSqsRecord({ name: 'SuccessJob', payload: { value: 1 } }, 'ok'),
      createSqsRecord({ name: 'SuccessJob', payload: { value: -1 } }, 'boom'),
      createSqsRecord({ name: 'MissingJob', payload: {} }, 'unregistered'),
    ]
    await createSqsHandler()({ Records: records })
    // Standard batches run concurrently, so the log order is not the batch order.
    const logged = errorLogs.map(line => JSON.parse(line)).sort((a, b) => a.messageId.localeCompare(b.messageId))
    expect(logged.map(entry => entry.messageId)).toEqual(['boom', 'unregistered'])
    expect(logged[0]).toMatchObject({ level: 'error', job: 'SuccessJob', attempt: 1, maxAttempts: 3, error: 'negative value' })
    expect(logged[1]).toMatchObject({ messageId: 'unregistered', error: 'Job class not found: MissingJob' })
  })

  test('retains the initial attempts offset in the message body', async () => {
    const record = createSqsRecord({ name: 'FailingJob', payload: { id: 'offset' }, attempts: 1, maxAttempts: 3 }, 'offset')
    record.attributes.ApproximateReceiveCount = '2'
    await createSqsHandler()({ Records: [record] })
    expect(failedCallPayload).toEqual({ id: 'offset' })
  })

  test('rejects missing or malformed counts before invoking application code', async () => {
    for (const receiveCount of [undefined, '', '0', '-1', '1.5', 'NaN', 'Infinity']) {
      const record = createSqsRecord({ name: 'SuccessJob', payload: { value: 1 } }, 'invalid')
      record.attributes = receiveCount === undefined ? {} : { ApproximateReceiveCount: receiveCount }
      expect(await createSqsHandler()({ Records: [record] })).toEqual({
        batchItemFailures: [{ itemIdentifier: 'invalid' }],
      })
    }
    expect(handled).toEqual([])
  })

  test('keeps terminal messages eligible for redrive even when failed() throws', async () => {
    class BrokenFailureHook extends Job {
      async handle() { throw new Error('handler error') }
      async failed() { throw new Error('hook error') }
    }
    registerJob(BrokenFailureHook)
    const record = createSqsRecord({ name: 'BrokenFailureHook', payload: {}, maxAttempts: 1 }, 'terminal')
    expect(await createSqsHandler()({ Records: [record] })).toEqual({
      batchItemFailures: [{ itemIdentifier: 'terminal' }],
    })
  })

  test('awaits each FIFO record and returns failed plus unprocessed records', async () => {
    const order: number[] = []
    class OrderedJob extends Job<{ step: number }> {
      async handle({ step }: { step: number }) {
        if (step === 1) await new Promise(resolve => setTimeout(resolve, 10))
        order.push(step)
        if (step === 2) throw new Error('stop here')
      }
    }
    registerJob(OrderedJob)
    const records = [1, 2, 3, 4].map(step => ({
      ...createSqsRecord({ name: 'OrderedJob', payload: { step } }, `msg-${step}`),
      eventSourceARN: FIFO_ARN,
      attributes: { ApproximateReceiveCount: '1', MessageGroupId: step === 4 ? 'other' : 'same' },
    }))
    expect(await createSqsHandler()({ Records: records })).toEqual({
      batchItemFailures: ['msg-2', 'msg-3', 'msg-4'].map(itemIdentifier => ({ itemIdentifier })),
    })
    expect(order).toEqual([1, 2])
    // The tail is reported without ever reaching a job, so these lines are the
    // only record that those deliveries were spent.
    const logged = errorLogs.map(line => JSON.parse(line))
    expect(logged.map(entry => entry.messageId)).toEqual(['msg-2', 'msg-3', 'msg-4'])
    expect(logged[1]).toMatchObject({ messageId: 'msg-3', stoppedAt: 'msg-2' })
  })

  test('acknowledges a completely successful FIFO batch', async () => {
    const records = [1, 2].map(value => ({
      ...createSqsRecord({ name: 'SuccessJob', payload: { value } }, String(value)),
      eventSourceARN: FIFO_ARN,
    }))
    expect(await createSqsHandler()({ Records: records })).toEqual({ batchItemFailures: [] })
    expect(handled).toEqual([{ value: 1 }, { value: 2 }])
  })

  test('stops a FIFO batch after malformed JSON without executing later records', async () => {
    const first = createSqsRecord({ name: 'SuccessJob', payload: { value: 1 } }, 'first')
    first.eventSourceARN = FIFO_ARN
    first.body = '{broken'
    const next = { ...createSqsRecord({ name: 'SuccessJob', payload: { value: 2 } }, 'next'), eventSourceARN: FIFO_ARN }
    expect(await createSqsHandler()({ Records: [first, next] })).toEqual({
      batchItemFailures: [{ itemIdentifier: 'first' }, { itemIdentifier: 'next' }],
    })
    expect(handled).toEqual([])
  })

  test('keeps standard queue processing concurrent', async () => {
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    class ConcurrentJob extends Job<{ step: number }> {
      async handle({ step }: { step: number }) {
        if (step === 1) await ready
        else release()
      }
    }
    registerJob(ConcurrentJob)
    const records = [1, 2].map(step => createSqsRecord({ name: 'ConcurrentJob', payload: { step } }, String(step)))
    expect(await createSqsHandler()({ Records: records })).toEqual({ batchItemFailures: [] })
  })
})

import type { QueueDriver, QueuedJob, FailedJob } from '../types'

/**
 * Abstracted SQS operations.
 * Users implement this interface by wrapping their SQS client (e.g. @aws-sdk/client-sqs).
 * This avoids a hard dependency on @aws-sdk/client-sqs in the framework.
 */
export interface SqsAdapter {
  /**
   * Send a message to an SQS queue.
   */
  sendMessage(params: {
    queueUrl: string
    messageBody: string
    delaySeconds: number
    messageGroupId?: string
    messageDeduplicationId?: string
  }): Promise<void>

  /**
   * Receive a single message from an SQS queue.
   */
  receiveMessage(params: {
    queueUrl: string
    waitTimeSeconds?: number
  }): Promise<{ body: string; receiptHandle: string } | null>

  /**
   * Change the visibility timeout of a message.
   */
  changeMessageVisibility(params: {
    queueUrl: string
    receiptHandle: string
    visibilityTimeout: number
  }): Promise<void>

  /**
   * Get the approximate number of messages in a queue.
   */
  getApproximateMessageCount(queueUrl: string): Promise<number>
}

/**
 * Options for SqsDriver.
 */
export interface SqsDriverOptions {
  /**
   * SQS queue URL for the primary queue.
   */
  queueUrl: string

  /**
   * Optional mapping of logical queue names to SQS queue URLs.
   * If not specified, all queues use the primary `queueUrl`.
   */
  queueUrls?: Record<string, string>

  /**
   * Message group ID for FIFO queues. If set, enables FIFO mode.
   */
  messageGroupId?: string
}

/**
 * Create an SqsAdapter from an @aws-sdk/client-sqs SQSClient.
 *
 * @example
 * ```ts
 * import { SQSClient } from '@aws-sdk/client-sqs'
 * import { createSqsAdapter, SqsDriver } from '@guren/server/queue'
 *
 * const client = new SQSClient({ region: 'ap-northeast-1' })
 * const adapter = createSqsAdapter(client)
 * const driver = new SqsDriver(adapter, { queueUrl: '...' })
 * ```
 */
export function createSqsAdapter(client: { send(command: unknown): Promise<unknown> }): SqsAdapter {
  return {
    async sendMessage(params) {
      const { SendMessageCommand } = await importSqs()
      const input: Record<string, unknown> = {
        QueueUrl: params.queueUrl,
        MessageBody: params.messageBody,
        DelaySeconds: params.delaySeconds,
      }
      if (params.messageGroupId) {
        input.MessageGroupId = params.messageGroupId
        input.MessageDeduplicationId = params.messageDeduplicationId
      }
      await client.send(new SendMessageCommand(input as any))
    },

    async receiveMessage(params) {
      const { ReceiveMessageCommand } = await importSqs()
      const result = (await client.send(
        new ReceiveMessageCommand({
          QueueUrl: params.queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: params.waitTimeSeconds ?? 5,
        } as any),
      )) as { Messages?: Array<{ Body?: string; ReceiptHandle?: string }> }

      const msg = result.Messages?.[0]
      if (!msg?.Body || !msg.ReceiptHandle) return null
      return { body: msg.Body, receiptHandle: msg.ReceiptHandle }
    },

    async changeMessageVisibility(params) {
      const { ChangeMessageVisibilityCommand } = await importSqs()
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: params.queueUrl,
          ReceiptHandle: params.receiptHandle,
          VisibilityTimeout: params.visibilityTimeout,
        } as any),
      )
    },

    async getApproximateMessageCount(queueUrl) {
      const { GetQueueAttributesCommand } = await importSqs()
      const result = (await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        } as any),
      )) as { Attributes?: Record<string, string> }
      return parseInt(result.Attributes?.ApproximateNumberOfMessages ?? '0', 10)
    },
  }
}

const SQS_MODULE = '@aws-sdk/client-sqs'

async function importSqs(): Promise<{
  SendMessageCommand: new (input: unknown) => unknown
  ReceiveMessageCommand: new (input: unknown) => unknown
  ChangeMessageVisibilityCommand: new (input: unknown) => unknown
  GetQueueAttributesCommand: new (input: unknown) => unknown
}> {
  try {
    return await import(SQS_MODULE)
  } catch {
    throw new Error(
      `Missing optional dependency "${SQS_MODULE}". Install @aws-sdk/client-sqs to use the SQS driver or createSqsAdapter.`,
    )
  }
}

/**
 * AWS SQS queue driver for serverless deployments.
 *
 * @example
 * ```ts
 * import { SQSClient } from '@aws-sdk/client-sqs'
 * import { createSqsAdapter, SqsDriver, setQueueDriver } from '@guren/server/queue'
 *
 * const adapter = createSqsAdapter(new SQSClient({ region: 'ap-northeast-1' }))
 * const driver = new SqsDriver(adapter, { queueUrl: process.env.SQS_QUEUE_URL! })
 * setQueueDriver(driver)
 *
 * // Dispatch jobs as usual
 * await SendEmailJob.dispatch({ to: 'user@example.com' })
 * ```
 */
export class SqsDriver implements QueueDriver {
  private readonly adapter: SqsAdapter
  private readonly options: SqsDriverOptions
  private readonly failedJobs: Map<string, FailedJob> = new Map()
  private readonly receiptHandles: Map<string, string> = new Map()

  constructor(adapter: SqsAdapter, options: SqsDriverOptions) {
    this.adapter = adapter
    this.options = options
  }

  async push(job: QueuedJob): Promise<void> {
    const delaySeconds = Math.min(
      900,
      Math.max(0, Math.floor((job.availableAt.getTime() - Date.now()) / 1000)),
    )

    await this.adapter.sendMessage({
      queueUrl: this.resolveQueueUrl(job.queue),
      messageBody: JSON.stringify(job),
      delaySeconds,
      messageGroupId: this.options.messageGroupId,
      messageDeduplicationId: this.options.messageGroupId ? job.id : undefined,
    })
  }

  async pop(queue: string): Promise<QueuedJob | null> {
    const result = await this.adapter.receiveMessage({
      queueUrl: this.resolveQueueUrl(queue),
    })

    if (!result) return null

    const job = deserializeJob(result.body)
    this.receiptHandles.set(job.id, result.receiptHandle)
    job.reservedAt = new Date()
    return job
  }

  async release(job: QueuedJob, delayMs: number = 0): Promise<void> {
    const receiptHandle = this.receiptHandles.get(job.id)
    if (receiptHandle) {
      await this.adapter.changeMessageVisibility({
        queueUrl: this.resolveQueueUrl(job.queue),
        receiptHandle,
        visibilityTimeout: Math.ceil(delayMs / 1000),
      })
      this.receiptHandles.delete(job.id)
    } else {
      job.reservedAt = null
      job.availableAt = new Date(Date.now() + delayMs)
      await this.push(job)
    }
  }

  async delete(jobId: string): Promise<void> {
    this.receiptHandles.delete(jobId)
  }

  async fail(job: QueuedJob, error: Error): Promise<void> {
    const failedJob: FailedJob = {
      ...job,
      failedAt: new Date(),
      error: error.message,
      stack: error.stack,
    }
    this.failedJobs.set(job.id, failedJob)
    this.receiptHandles.delete(job.id)
  }

  async size(queue: string): Promise<number> {
    return this.adapter.getApproximateMessageCount(this.resolveQueueUrl(queue))
  }

  async getFailedJobs(queue?: string): Promise<FailedJob[]> {
    const jobs: FailedJob[] = []
    for (const job of this.failedJobs.values()) {
      if (!queue || job.queue === queue) {
        jobs.push({ ...job })
      }
    }
    return jobs.sort((a, b) => b.failedAt.getTime() - a.failedAt.getTime())
  }

  async retryFailedJob(jobId: string): Promise<void> {
    const failedJob = this.failedJobs.get(jobId)
    if (!failedJob) {
      throw new Error(`Failed job not found: ${jobId}`)
    }

    const job: QueuedJob = {
      id: failedJob.id,
      name: failedJob.name,
      payload: failedJob.payload,
      queue: failedJob.queue,
      attempts: 0,
      maxAttempts: failedJob.maxAttempts,
      availableAt: new Date(),
      createdAt: new Date(),
      reservedAt: null,
    }

    await this.push(job)
    this.failedJobs.delete(jobId)
  }

  async deleteFailedJob(jobId: string): Promise<void> {
    this.failedJobs.delete(jobId)
  }

  async clear(): Promise<void> {
    this.failedJobs.clear()
    this.receiptHandles.clear()
  }

  private resolveQueueUrl(queue: string): string {
    return this.options.queueUrls?.[queue] ?? this.options.queueUrl
  }
}

/**
 * Deserialize a JSON string into a QueuedJob, restoring Date objects.
 */
function deserializeJob(body: string): QueuedJob {
  const raw = JSON.parse(body)
  return {
    ...raw,
    availableAt: new Date(raw.availableAt),
    createdAt: new Date(raw.createdAt),
    reservedAt: raw.reservedAt ? new Date(raw.reservedAt) : null,
  }
}

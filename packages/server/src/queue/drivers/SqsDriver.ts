import type { QueueDriver, QueuedJob, FailedJob } from '../types'
import { warnOnce } from '../../support/warn-once'

/**
 * Implemented by wrapping your own SQS client, which keeps @aws-sdk/client-sqs
 * out of the framework's dependencies.
 */
export interface SqsAdapter {
  sendMessage(params: {
    queueUrl: string
    messageBody: string
    delaySeconds: number
    messageGroupId?: string
    messageDeduplicationId?: string
  }): Promise<void>

  receiveMessage(params: {
    queueUrl: string
    waitTimeSeconds?: number
  }): Promise<{ body: string; receiptHandle: string } | null>

  /**
   * Optional so adapters written before this method keep compiling; without it
   * SQS redelivers every acknowledged job once the visibility timeout expires.
   */
  deleteMessage?(params: { queueUrl: string; receiptHandle: string }): Promise<void>

  changeMessageVisibility(params: {
    queueUrl: string
    receiptHandle: string
    visibilityTimeout: number
  }): Promise<void>

  getApproximateMessageCount(queueUrl: string): Promise<number>
}

export interface SqsDriverOptions {
  queueUrl: string

  /** Logical queue name to SQS URL; unlisted queues use `queueUrl`. */
  queueUrls?: Record<string, string>

  /** Setting this enables FIFO mode. */
  messageGroupId?: string
}

/** Builds an SqsAdapter over an @aws-sdk/client-sqs SQSClient. */
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

    async deleteMessage(params) {
      const { DeleteMessageCommand } = await importSqs()
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: params.queueUrl,
          ReceiptHandle: params.receiptHandle,
        } as any),
      )
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
  DeleteMessageCommand: new (input: unknown) => unknown
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

/** AWS SQS queue driver for serverless deployments. */
export class SqsDriver implements QueueDriver {
  private readonly adapter: SqsAdapter
  private readonly options: SqsDriverOptions
  private readonly failedJobs: Map<string, FailedJob> = new Map()
  private readonly reservations: Map<string, Reservation> = new Map()

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
    const queueUrl = this.resolveQueueUrl(queue)
    const result = await this.adapter.receiveMessage({ queueUrl })

    if (!result) return null

    const job = deserializeJob(result.body)
    this.reservations.set(job.id, { receiptHandle: result.receiptHandle, queueUrl })
    job.reservedAt = new Date()
    return job
  }

  async release(job: QueuedJob, delayMs: number = 0): Promise<void> {
    const reservation = this.reservations.get(job.id)
    if (reservation) {
      await this.adapter.changeMessageVisibility({
        queueUrl: reservation.queueUrl,
        receiptHandle: reservation.receiptHandle,
        visibilityTimeout: Math.ceil(delayMs / 1000),
      })
      this.reservations.delete(job.id)
    } else {
      job.reservedAt = null
      job.availableAt = new Date(Date.now() + delayMs)
      await this.push(job)
    }
  }

  async delete(jobId: string): Promise<void> {
    await this.acknowledge(jobId)
  }

  async fail(job: QueuedJob, error: Error): Promise<void> {
    const failedJob: FailedJob = {
      ...job,
      failedAt: new Date(),
      error: error.message,
      stack: error.stack,
    }
    this.failedJobs.set(job.id, failedJob)
    await this.acknowledge(job.id)
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
    this.reservations.clear()
  }

  /** Drops the reservation only once SQS has accepted the deletion. */
  private async acknowledge(jobId: string): Promise<void> {
    const reservation = this.reservations.get(jobId)
    if (!reservation) return

    if (this.adapter.deleteMessage) {
      await this.adapter.deleteMessage({
        queueUrl: reservation.queueUrl,
        receiptHandle: reservation.receiptHandle,
      })
    } else {
      warnOnce(
        'sqs-adapter-missing-delete-message',
        '[guren] The SqsAdapter has no deleteMessage(): acknowledged jobs stay on the queue and SQS redelivers them '
          + 'once the visibility timeout expires. Implement deleteMessage() on your adapter, or build it with '
          + 'createSqsAdapter().',
      )
    }

    this.reservations.delete(jobId)
  }

  private resolveQueueUrl(queue: string): string {
    return this.options.queueUrls?.[queue] ?? this.options.queueUrl
  }
}

interface Reservation {
  receiptHandle: string
  queueUrl: string
}

function deserializeJob(body: string): QueuedJob {
  const raw = JSON.parse(body)
  return {
    ...raw,
    availableAt: new Date(raw.availableAt),
    createdAt: new Date(raw.createdAt),
    reservedAt: raw.reservedAt ? new Date(raw.reservedAt) : null,
  }
}

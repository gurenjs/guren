import { handle } from 'hono/aws-lambda'

import type { Application } from '../http/Application'
import type { Scheduler } from '../scheduling/Scheduler'
import type { ConsoleKernel } from '../console/ConsoleKernel'
import { getJob } from '../queue/Job'
import { detectServerlessRuntime } from '../runtime/serverless'

export type { APIGatewayProxyResult, LambdaEvent } from 'hono/aws-lambda'

/** SQS event record from AWS Lambda. */
export interface SqsRecord {
  messageId: string
  receiptHandle: string
  body: string
  attributes: Record<string, string>
  messageAttributes: Record<string, unknown>
  md5OfBody: string
  eventSource: string
  eventSourceARN: string
  awsRegion: string
}

/** SQS event payload from AWS Lambda. */
export interface SqsEvent {
  Records: SqsRecord[]
}

/** SQS batch item failure for partial batch response. */
export interface SqsBatchItemFailure {
  itemIdentifier: string
}

/** SQS batch response with partial failures. */
export interface SqsBatchResponse {
  batchItemFailures: SqsBatchItemFailure[]
}

/** Create an AWS Lambda handler from an already booted Guren application. */
export function createLambdaHandler(app: Application) {
  return handle(app.hono)
}

/**
 * Create an AWS Lambda handler for SQS queue jobs. Reports partial batch
 * failures, so only failed messages go back to SQS for retry.
 */
export function createSqsHandler(): (event: SqsEvent) => Promise<SqsBatchResponse> {
  return async (event: SqsEvent): Promise<SqsBatchResponse> => {
    // AWS FIFO batches must stop after the first failure, including records
    // from other groups. Unprocessed records stay on SQS with the failed one.
    if (event.Records.some((record) => record.eventSourceARN.endsWith('.fifo'))) {
      for (let index = 0; index < event.Records.length; index++) {
        try {
          await processSqsRecord(event.Records[index])
        } catch {
          const stopped = event.Records.slice(index)
          // The tail never reaches processSqsRecord, so its ids log here or
          // nowhere: its deliveries still count against every job's budget.
          if (stopped.length > 1) {
            console.error(JSON.stringify({
              level: 'error',
              msg: 'SQS FIFO batch stopped before its remaining records',
              messageId: stopped[0].messageId,
              unprocessed: stopped.slice(1).map((record) => record.messageId),
            }))
          }
          return { batchItemFailures: stopped.map((record) => ({ itemIdentifier: record.messageId })) }
        }
      }
      return { batchItemFailures: [] }
    }

    const results = await Promise.allSettled(event.Records.map(processSqsRecord))
    return {
      batchItemFailures: event.Records
        .filter((_, index) => results[index].status === 'rejected')
        .map((record) => ({ itemIdentifier: record.messageId })),
    }
  }
}

async function processSqsRecord(record: SqsRecord): Promise<void> {
  let job: SqsJobBody | undefined
  try {
    job = deserializeSqsJob(record.body)
    const JobClass = getJob(job.name)
    if (!JobClass) throw new Error(`Job class not found: ${job.name}`)

    const receiveCount = Number(record.attributes.ApproximateReceiveCount)
    if (!Number.isSafeInteger(receiveCount) || receiveCount < 1) {
      throw new Error('SQS records require a positive ApproximateReceiveCount.')
    }
    if (!Number.isSafeInteger(job.attempts) || job.attempts < 0
      || !Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < 1
      || !Number.isSafeInteger(job.attempts + receiveCount)) {
      throw new Error('SQS jobs require valid attempts and maxAttempts counts.')
    }
    // Body is unchanged on redelivery; the AWS attribute survives invocations.
    job.attempts += receiveCount

    // Past the budget the message is only waiting for the queue's redrive
    // policy. failed() is not called here: either it already ran on the
    // delivery that spent the last attempt, or the deliveries were spent
    // elsewhere (a FIFO record left unprocessed) and handle() never ran.
    if (job.attempts > job.maxAttempts) {
      throw new Error(`SQS job exceeded maxAttempts (${job.maxAttempts}).`)
    }

    const instance = new JobClass()
    try {
      await instance.handle(job.payload)
    } catch (error) {
      // Only the delivery that spends the last attempt, so failed() runs once
      // with the real error, as Worker.handleFailedJob does.
      if (job.attempts >= job.maxAttempts && instance.failed) {
        try {
          await instance.failed(job.payload, error as Error)
        } catch (hookError) {
          // Keep the original failure in the partial batch response for redrive.
          console.error(JSON.stringify({
            level: 'error',
            msg: `Error in job.failed() handler: ${job.name}`,
            messageId: record.messageId,
            job: job.name,
            error: (hookError as Error).message,
          }))
        }
      }
      throw error
    }
  } catch (error) {
    // batchItemFailures carries message ids only, so this is the one place a
    // record's failure reason is visible before the queue's redrive policy.
    console.error(JSON.stringify({
      level: 'error',
      msg: `SQS job failed: ${job?.name ?? 'unknown'}`,
      messageId: record.messageId,
      job: job?.name,
      queue: job?.queue,
      attempt: job?.attempts,
      maxAttempts: job?.maxAttempts,
      error: (error as Error).message,
    }))
    throw error
  }
}

/** Create an AWS Lambda handler for running scheduled tasks via EventBridge. */
export function createScheduleHandler(
  scheduler: Scheduler,
): () => Promise<void> {
  return async (): Promise<void> => {
    await scheduler.runDueTasks()
  }
}

/** Console command event payload for Lambda. */
export interface ConsoleEvent {
  /** Command string to execute, e.g. `"users:create jo@example.com --admin"`. */
  command: string
}

/** Console command result from Lambda. */
export interface ConsoleResult {
  exitCode: number
}

/**
 * Create an AWS Lambda handler for running console commands. Invoke via AWS
 * CLI, SDK, or EventBridge with a payload like `{ "command": "db:migrate" }`.
 */
export function createConsoleHandler(
  kernel: ConsoleKernel,
): (event: ConsoleEvent) => Promise<ConsoleResult> {
  return async (event: ConsoleEvent): Promise<ConsoleResult> => {
    const argv = event.command.split(/\s+/).filter(Boolean)
    const exitCode = await kernel.handle(argv)
    return { exitCode }
  }
}

/**
 * Whether the process is running inside AWS Lambda, by the
 * `AWS_LAMBDA_FUNCTION_NAME` variable AWS sets in every Lambda runtime.
 */
export function isLambda(): boolean {
  return detectServerlessRuntime()?.id === 'lambda'
}

/** Get Lambda environment metadata, or null if not running on Lambda. */
export function getLambdaContext(): LambdaRuntimeContext | null {
  if (!isLambda()) return null

  return {
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME!,
    functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION || '$LATEST',
    memorySize: parseInt(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE || '128', 10),
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    logGroup: process.env.AWS_LAMBDA_LOG_GROUP_NAME,
    logStream: process.env.AWS_LAMBDA_LOG_STREAM_NAME,
    tmpDir: '/tmp',
  }
}

/** Lambda runtime context metadata. */
export interface LambdaRuntimeContext {
  functionName: string
  functionVersion: string
  memorySize: number
  region: string
  logGroup?: string
  logStream?: string
  tmpDir: string
}

/** The queued job a message body carries; validated before it is trusted. */
interface SqsJobBody {
  name: string
  payload: unknown
  queue: string
  attempts: number
  maxAttempts: number
  availableAt: Date
  createdAt: Date
  reservedAt: Date | null
}

/** Deserialize a JSON SQS message body into a QueuedJob-like object. */
function deserializeSqsJob(body: string): SqsJobBody {
  const raw = JSON.parse(body) as SqsJobBody
  return {
    ...raw,
    availableAt: new Date(raw.availableAt),
    createdAt: new Date(raw.createdAt),
    reservedAt: raw.reservedAt ? new Date(raw.reservedAt) : null,
  }
}

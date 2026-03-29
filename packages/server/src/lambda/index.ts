import { handle } from 'hono/aws-lambda'

import type { Application } from '../http/Application'
import type { Scheduler } from '../scheduling/Scheduler'
import type { ConsoleKernel } from '../console/ConsoleKernel'
import { getJob } from '../queue/Job'

export type { APIGatewayProxyResult, LambdaEvent } from 'hono/aws-lambda'

/**
 * SQS event record from AWS Lambda.
 */
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

/**
 * SQS event payload from AWS Lambda.
 */
export interface SqsEvent {
  Records: SqsRecord[]
}

/**
 * SQS batch item failure for partial batch response.
 */
export interface SqsBatchItemFailure {
  itemIdentifier: string
}

/**
 * SQS batch response with partial failures.
 */
export interface SqsBatchResponse {
  batchItemFailures: SqsBatchItemFailure[]
}

/**
 * Create an AWS Lambda handler from a booted Guren application.
 *
 * @example
 * ```typescript
 * import app from './src/app'
 * import { createLambdaHandler } from '@guren/server/lambda'
 *
 * await app.boot()
 * export const handler = createLambdaHandler(app)
 * ```
 */
export function createLambdaHandler(app: Application) {
  return handle(app.hono)
}

/**
 * Create an AWS Lambda handler for processing SQS queue jobs.
 *
 * Supports partial batch failure reporting — only failed messages
 * are returned to SQS for retry, while successful ones are deleted.
 *
 * @example
 * ```typescript
 * import app from './src/app'
 * import { createSqsHandler } from '@guren/server/lambda'
 *
 * await app.boot()
 * export const queue = createSqsHandler()
 * ```
 */
export function createSqsHandler(): (event: SqsEvent) => Promise<SqsBatchResponse> {
  return async (event: SqsEvent): Promise<SqsBatchResponse> => {
    const failures: SqsBatchItemFailure[] = []

    const results = await Promise.allSettled(
      event.Records.map(async (record) => {
        const job = deserializeSqsJob(record.body)

        const JobClass = getJob(job.name)
        if (!JobClass) {
          throw new Error(`Job class not found: ${job.name}`)
        }

        const instance = new JobClass()
        job.attempts++

        try {
          await instance.handle(job.payload)
        } catch (error) {
          // If max attempts reached, call the failed handler
          if (job.attempts >= job.maxAttempts && instance.failed) {
            try {
              await instance.failed(job.payload, error as Error)
            } catch {
              // Swallow errors in failed handler
            }
          }
          throw error
        }
      }),
    )

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        failures.push({ itemIdentifier: event.Records[i].messageId })
      }
    }

    return { batchItemFailures: failures }
  }
}

/**
 * Create an AWS Lambda handler for running scheduled tasks via EventBridge.
 *
 * @example
 * ```typescript
 * import { createScheduleHandler } from '@guren/server/lambda'
 * import { scheduler } from './src/scheduler'
 *
 * export const schedule = createScheduleHandler(scheduler)
 * ```
 */
export function createScheduleHandler(
  scheduler: Scheduler,
): () => Promise<void> {
  return async (): Promise<void> => {
    await scheduler.runDueTasks()
  }
}

/**
 * Console command event payload for Lambda.
 */
export interface ConsoleEvent {
  /**
   * Command string to execute (e.g. "db:migrate", "users:create john@example.com --admin").
   */
  command: string
}

/**
 * Console command result from Lambda.
 */
export interface ConsoleResult {
  exitCode: number
}

/**
 * Create an AWS Lambda handler for running console commands.
 *
 * Invoke via AWS CLI, SDK, or EventBridge with a JSON payload:
 * `{ "command": "db:migrate" }`
 *
 * @example
 * ```typescript
 * import { createConsoleHandler } from '@guren/server/lambda'
 * import { kernel } from './src/console'
 *
 * export const console = createConsoleHandler(kernel)
 * ```
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
 * Detect if the current process is running inside AWS Lambda.
 *
 * Checks for the `AWS_LAMBDA_FUNCTION_NAME` environment variable,
 * which AWS sets automatically in all Lambda runtimes.
 */
export function isLambda(): boolean {
  return typeof process !== 'undefined' && !!process.env?.AWS_LAMBDA_FUNCTION_NAME
}

/**
 * Get Lambda environment metadata, or null if not running on Lambda.
 */
export function getLambdaContext(): LambdaRuntimeContext | null {
  if (!isLambda()) return null

  return {
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME!,
    functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION ?? '$LATEST',
    memorySize: parseInt(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? '128', 10),
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    logGroup: process.env.AWS_LAMBDA_LOG_GROUP_NAME,
    logStream: process.env.AWS_LAMBDA_LOG_STREAM_NAME,
    tmpDir: '/tmp',
  }
}

/**
 * Lambda runtime context metadata.
 */
export interface LambdaRuntimeContext {
  functionName: string
  functionVersion: string
  memorySize: number
  region: string
  logGroup?: string
  logStream?: string
  tmpDir: string
}

/**
 * Deserialize a JSON SQS message body into a QueuedJob-like object.
 */
function deserializeSqsJob(body: string) {
  const raw = JSON.parse(body)
  return {
    ...raw,
    availableAt: new Date(raw.availableAt),
    createdAt: new Date(raw.createdAt),
    reservedAt: raw.reservedAt ? new Date(raw.reservedAt) : null,
  }
}

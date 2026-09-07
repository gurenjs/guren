/**
 * The isolate's one boot slot (RFC 0017 §6).
 *
 * A worker's `fetch` export is not the only entrypoint: an alarm can wake an
 * agent Durable Object before any request has arrived, and a second entrypoint
 * with its own boot would race the module-global env holder. So boot is a
 * shared primitive — promise-latched, first caller wins, everyone awaits the
 * same latch. Keyed per app (a Bun test suite boots many); the env holder stays
 * module-global, since `getWorkersEnv()` has no app to key on — one per isolate.
 */
import type { Scheduler } from '@guren/core'

import { captureWorkersEnv, resetWorkersEnv } from './env'

export interface WorkersExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException?(): void
}

/** The `ScheduledEvent` a cron trigger delivers, structural like `WorkersExecutionContext`. */
export interface WorkersScheduledEvent {
  /** The `triggers.crons` entry that fired. */
  cron?: string
  /** Epoch ms of the minute the trigger was *meant* for; workerd may deliver it late. */
  scheduledTime?: number
}

/**
 * The shape the Workers entrypoints need from an app. Structural rather than
 * `Application` itself, so `boot()` is not assumed to be idempotent.
 */
export interface WorkersAppLike {
  boot(): Promise<void>
  fetch(request: Request, env?: unknown, executionCtx?: unknown): Response | Promise<Response>
  /** Only the cron entrypoint reads it, so an app-like that never receives one still satisfies boot/fetch. */
  container?: { makeOptional<T>(key: string): T | undefined }
}

const latches = new WeakMap<WorkersAppLike, Promise<void>>()

/**
 * Boot `app` against `env`, once per isolate.
 *
 * Boot is deferred to the first request or wake because it performs I/O (ORM
 * setup against D1), which workerd forbids in global scope (RFC 0003).
 * @throws Whatever `boot()` threw, and `captureWorkersEnv`'s refusal of a second env.
 */
export async function bootWorkersApp(app: WorkersAppLike, env: unknown): Promise<void> {
  // Outside the try: this refusal means another entrypoint captured a *live*
  // env, which the cleanup below must not clear.
  captureWorkersEnv(env)

  let attempt: Promise<void> | undefined

  try {
    // Inside the try: a conforming non-async boot() can throw synchronously,
    // and that throw has to reach the cleanup too.
    attempt = latches.get(app)
    if (!attempt) {
      attempt = app.boot()
      latches.set(app, attempt)
    }
    await attempt
  } catch (error) {
    // Every waiter on a failed boot reaches here, but only the one whose attempt
    // is still installed may clear: a retry can install its boot promise and env
    // between two waiters' catches, before its first `await`. The same token
    // settles the env holder, which is reset nowhere else in production.
    if (latches.get(app) === attempt) {
      latches.delete(app)
      resetWorkersEnv()
    }
    throw error
  }
}

/** Boot, then dispatch — the topology every Workers entrypoint shares. */
export async function bootAndFetch(
  app: WorkersAppLike,
  request: Request,
  env: unknown,
  ctx?: WorkersExecutionContext,
): Promise<Response> {
  await bootWorkersApp(app, env)
  return app.fetch(request, env, ctx)
}

/**
 * Boot, then run every task whose cron matches the trigger's minute.
 *
 * `scheduledTime` rather than the wall clock: workerd may deliver a trigger late.
 * @throws When no provider bound a `scheduler` — a cron that swept nothing must
 *   not report success on a schedule nobody reads.
 */
export async function bootAndRunDueTasks(
  app: WorkersAppLike,
  event: WorkersScheduledEvent,
  env: unknown,
): Promise<void> {
  await bootWorkersApp(app, env)

  const scheduler = app.container?.makeOptional<Scheduler>('scheduler')
  if (!scheduler) {
    throw new Error(
      'A Cloudflare cron trigger fired, but this app binds no `scheduler`. Register a provider that binds createScheduler() as `scheduler` and defines the tasks, or remove "triggers.crons" from wrangler.jsonc.',
    )
  }

  await scheduler.runDueTasks(event.scheduledTime ? new Date(event.scheduledTime) : new Date())
}

import { captureWorkersEnv, resetWorkersEnv } from './env'

export interface WorkersExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException?(): void
}

/**
 * The shape `createWorkersHandler` needs from an app. Structural rather than
 * `Application` itself, so `boot()` is not assumed to be idempotent.
 */
export interface WorkersAppLike {
  boot(): Promise<void>
  fetch(request: Request, env?: unknown, executionCtx?: unknown): Response | Promise<Response>
}

export interface WorkersHandler {
  fetch(request: Request, env: unknown, ctx: WorkersExecutionContext): Promise<Response>
}

export function createWorkersHandler(app: WorkersAppLike): WorkersHandler {
  // Boot is deferred to the first request because it performs I/O (ORM setup
  // against D1), which workerd forbids in global scope (RFC 0003). Deduped here
  // because conforming to `WorkersAppLike` does not imply an idempotent `boot()`.
  let bootPromise: Promise<void> | undefined

  return {
    async fetch(request: Request, env: unknown, ctx: WorkersExecutionContext): Promise<Response> {
      captureWorkersEnv(env)

      let attempt: Promise<void> | undefined

      try {
        // Inside the try: a conforming non-async boot() can throw synchronously,
        // and that throw has to reach the cleanup too.
        attempt = bootPromise ??= app.boot()
        await attempt
      } catch (error) {
        // Every waiter on a failed boot reaches here, but only the one whose attempt
        // is still installed may clear: a retry can install its boot promise and env
        // between two waiters' catches, before its first `await`. The same token
        // settles the env holder (first-call-wins, reset nowhere else in production);
        // that relies on `buildCloudflareOutput`'s one-handler-per-module topology.
        if (bootPromise === attempt) {
          bootPromise = undefined
          resetWorkersEnv()
        }
        throw error
      }

      return app.fetch(request, env, ctx)
    },
  }
}

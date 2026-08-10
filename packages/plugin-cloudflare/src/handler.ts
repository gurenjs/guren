import { captureWorkersEnv, resetWorkersEnv } from './env'

export interface WorkersExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException?(): void
}

/**
 * The shape `createWorkersHandler` needs from an app. Structural rather than
 * `Application` itself, so `boot()` is not assumed to be idempotent — each
 * handler dedupes boot across its own requests for anything conforming here.
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
  // against D1), which workerd forbids in global scope — not because bindings
  // are unreachable there (RFC 0003). Deduped here rather than delegated to
  // the app: conforming to `WorkersAppLike` does not imply an idempotent
  // `boot()`.
  let bootPromise: Promise<void> | undefined

  return {
    async fetch(request: Request, env: unknown, ctx: WorkersExecutionContext): Promise<Response> {
      captureWorkersEnv(env)

      bootPromise ??= app.boot()

      try {
        await bootPromise
      } catch (error) {
        bootPromise = undefined
        resetWorkersEnv()
        throw error
      }

      return app.fetch(request, env, ctx)
    },
  }
}

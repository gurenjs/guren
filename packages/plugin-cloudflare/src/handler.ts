import { captureWorkersEnv, resetWorkersEnv } from './env'

export interface WorkersExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException?(): void
}

/**
 * The shape `createWorkersHandler` needs from an app. Structural rather than
 * `Application` itself, so `boot()` is not assumed to be idempotent — the
 * handler guarantees boot-once for anything conforming to this type.
 */
export interface WorkersAppLike {
  boot(): Promise<void>
  fetch(request: Request, env?: unknown, executionCtx?: unknown): Response | Promise<Response>
}

export interface WorkersHandler {
  fetch(request: Request, env: unknown, ctx: WorkersExecutionContext): Promise<Response>
}

export function createWorkersHandler(app: WorkersAppLike): WorkersHandler {
  // Bindings only arrive with `fetch`, so boot is deferred to the first request
  // and shared by everything that races it. `Application.boot()` memoizes the
  // same way, but this is not redundant: `WorkersAppLike` is a published
  // structural type, so the app here need not be a Guren `Application`. Drop
  // this and the guarantee narrows to "whatever you passed already dedupes".
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

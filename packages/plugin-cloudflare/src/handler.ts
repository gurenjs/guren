import { captureWorkersEnv, resetWorkersEnv } from './env'

export interface WorkersExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException?(): void
}

export interface WorkersAppLike {
  boot(): Promise<void>
  fetch(request: Request, env?: unknown, executionCtx?: unknown): Response | Promise<Response>
}

export interface WorkersHandler {
  fetch(request: Request, env: unknown, ctx: WorkersExecutionContext): Promise<Response>
}

export function createWorkersHandler(app: WorkersAppLike): WorkersHandler {
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

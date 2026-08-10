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

      let attempt: Promise<void> | undefined

      try {
        // Inside the try: a conforming non-async boot() can throw
        // synchronously, and that throw has to reach the cleanup too.
        attempt = bootPromise ??= app.boot()
        await attempt
      } catch (error) {
        // Every waiter on a failed boot reaches here, but only the one whose
        // attempt is still installed may clear: a retry can start between two
        // waiters' catches — the app can register a rejection reaction on the
        // very promise `boot()` returned — and `fetch` installs the new boot
        // promise and captures the new env before its first `await`, so a
        // stale waiter clearing unconditionally wipes a live retry.
        //
        // The same token settles the env holder, which is module-global: it is
        // first-call-wins and this is its only production reset, so still
        // owning the boot promise means the holder still holds what this
        // request captured. A synchronous throw leaves both sides `undefined`
        // and nothing can interleave before the catch, so that path clears its
        // own capture.
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

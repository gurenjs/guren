import { bootAndFetch, bootWorkersApp } from './boot'
import type { WorkersAppLike, WorkersExecutionContext } from './boot'

export type { WorkersAppLike, WorkersExecutionContext }

export interface WorkersHandler {
  fetch(request: Request, env: unknown, ctx: WorkersExecutionContext): Promise<Response>
  /**
   * Boot without dispatching, for an entrypoint that holds `env` but no request
   * — an agent Durable Object woken by an alarm (RFC 0017 §6).
   */
  boot(env: unknown): Promise<void>
}

/**
 * The worker entry `guren cloudflare:build` generates.
 *
 * One per module: it carries the isolate's boot slot, and `boot.ts` is where
 * that invariant is specified.
 */
export function createWorkersHandler(app: WorkersAppLike): WorkersHandler {
  return {
    fetch: (request, env, ctx) => bootAndFetch(app, request, env, ctx),
    boot: (env) => bootWorkersApp(app, env),
  }
}

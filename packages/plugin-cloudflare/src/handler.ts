import { bootAndFetch, bootAndRunDueTasks, bootWorkersApp } from './boot'
import type { WorkersAppLike, WorkersExecutionContext, WorkersScheduledEvent } from './boot'

export type { WorkersAppLike, WorkersExecutionContext, WorkersScheduledEvent }

export interface WorkersHandler {
  fetch(request: Request, env: unknown, ctx: WorkersExecutionContext): Promise<Response>
  /**
   * A cron trigger declared in `triggers.crons`, dispatched to the app's
   * `scheduler`. Awaited rather than handed to `ctx.waitUntil`: the invocation
   * lives exactly as long as the tasks it fired.
   */
  scheduled(event: WorkersScheduledEvent, env: unknown, ctx: WorkersExecutionContext): Promise<void>
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
    scheduled: (event, env) => bootAndRunDueTasks(app, event, env),
    boot: (env) => bootWorkersApp(app, env),
  }
}

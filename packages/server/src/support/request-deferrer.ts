/**
 * The `waitUntil` of the Workers request being served, for code that holds no
 * request: a container-singleton `Logger` resolved inside a service, say. Only a
 * fetch handler abandons unfinished work when its context closes (a Durable
 * Object keeps it), so `Application.fetch` is the one place that enters a scope.
 */
// Static, unlike the ORM's lazy import: the store must exist the moment `fetch`
// is entered. workerd provides the module under `nodejs_compat`.
import { AsyncLocalStorage } from 'node:async_hooks'

/** `ExecutionContext.waitUntil`, bound to its context. */
export type Deferrer = (work: Promise<unknown>) => void

const scope = new AsyncLocalStorage<Deferrer>()

/**
 * `ctx` is typed `unknown` because `app.fetch`'s third argument is a cast
 * wherever it arrives from. One without a callable `waitUntil` (every runtime
 * but Workers) enters no scope, so a nested call keeps the outer request's.
 */
export function runInRequestScope<T>(ctx: unknown, fn: () => T): T {
  const waitUntil = (ctx as { waitUntil?: unknown } | null | undefined)?.waitUntil
  return typeof waitUntil === 'function' ? scope.run(waitUntil.bind(ctx) as Deferrer, fn) : fn()
}

/** The deferrer of the request this code runs for, when one was entered. */
export function requestDeferrer(): Deferrer | undefined {
  return scope.getStore()
}

import type { Context } from 'hono'
import type { RequestContextLike } from '../http/request-container'

/**
 * Registry for the app's route contracts: `guren codegen` merges a `routes` map
 * (route name → the parsed `params`/`query`/`body` its contract declares) into
 * this interface. Left empty, `Controller.validated()` accepts any route name.
 */
export interface GurenRouteContracts {}

type RegisteredRouteContracts = GurenRouteContracts extends { routes: infer R extends object } ? R : never

/** A route name `Controller.validated()` accepts: a registered one after codegen, any string before. */
export type ContractRouteName = [RegisteredRouteContracts] extends [never]
  ? string
  : keyof RegisteredRouteContracts & string

/** What `Controller.validated()` returns when no contract type is registered for the route. */
export interface UntypedValidatedInput {
  params: Record<string, any> | undefined
  query: Record<string, any> | undefined
  body: any
}

type SegmentOf<TEntry, TKey extends string> = TEntry extends { [K in TKey]: infer T } ? T : undefined

/** The contract-parsed input of one route. A segment the contract does not declare is `undefined`. */
export type ValidatedInput<TName extends string = string> = [RegisteredRouteContracts] extends [never]
  ? UntypedValidatedInput
  : TName extends keyof RegisteredRouteContracts
    ? {
        params: SegmentOf<RegisteredRouteContracts[TName], 'params'>
        query: SegmentOf<RegisteredRouteContracts[TName], 'query'>
        body: SegmentOf<RegisteredRouteContracts[TName], 'body'>
      }
    : UntypedValidatedInput

/** The request-scoped record the contract middleware leaves for the controller action. */
export interface ValidatedInputRecord {
  /** The route's name at mount time, so a `validated('other.route')` call can be refused. */
  route: string | undefined
  params?: unknown
  query?: unknown
  body?: unknown
  /** The payload the body schema parsed; boxed because `null` and `''` are parsed bodies too. */
  rawBody?: { value: unknown }
}

export const VALIDATED_INPUT_CONTEXT_KEY = 'guren.validatedInput'

declare module 'hono' {
  interface ContextVariableMap {
    [VALIDATED_INPUT_CONTEXT_KEY]: ValidatedInputRecord
  }
}

export function getValidatedInput(ctx: RequestContextLike): ValidatedInputRecord | undefined {
  return ctx.get(VALIDATED_INPUT_CONTEXT_KEY) as ValidatedInputRecord | undefined
}

export function setValidatedInput(ctx: Context, record: ValidatedInputRecord): void {
  ctx.set(VALIDATED_INPUT_CONTEXT_KEY, record)
}

/**
 * `Controller.validated()`, shared with `@guren/testing`'s controller mock so the
 * two refuse the same calls. `route` lists every name the action is mounted on.
 */
export function readValidatedInput(ctx: RequestContextLike, route?: string | readonly string[]): UntypedValidatedInput {
  const record = getValidatedInput(ctx)
  if (!record) {
    throw new Error(
      'Controller.validated() found no contract-validated input: the route declares no `params`, `query` '
      + 'or `body` schema. Add one to the route options, or use validateBody()/validateQuery()/validateParams(). '
      + 'In a controller unit test, seed it with contractInput().',
    )
  }
  const names: readonly string[] | undefined = typeof route === 'string' ? [route] : route
  if (names && (record.route === undefined || !names.includes(record.route))) {
    throw new Error(
      `Controller.validated(${JSON.stringify(route)}) was called while serving `
      + `${record.route === undefined ? 'an unnamed route' : `route '${record.route}'`}. `
      + 'Pass the name of every route this action is mounted on.',
    )
  }
  return {
    params: record.params as Record<string, unknown> | undefined,
    query: record.query as Record<string, unknown> | undefined,
    body: record.body,
  }
}

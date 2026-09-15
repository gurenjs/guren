import type { Context } from 'hono'

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
  params: Record<string, any>
  query: Record<string, any>
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

type ContextReader = { get(key: string): unknown }
type ContextWriter = { set(key: string, value: unknown): void }

export function getValidatedInput(ctx: Context | ContextReader): ValidatedInputRecord | undefined {
  return (ctx as ContextReader).get(VALIDATED_INPUT_CONTEXT_KEY) as ValidatedInputRecord | undefined
}

export function setValidatedInput(ctx: Context | ContextWriter, record: ValidatedInputRecord): void {
  ;(ctx as ContextWriter).set(VALIDATED_INPUT_CONTEXT_KEY, record)
}

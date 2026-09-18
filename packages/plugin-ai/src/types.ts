/**
 * The augmentation targets RFC 0029 §11 names. Empty in the plugin; an app's
 * generated `.guren/agents.gen.ts`, its `config/ai.ts` and its `app/Ai/agents.ts`
 * fill them. While one is empty, the name type it backs is plain `string`.
 */

/** Tool names `appTools()` accepts, keyed by `AgentToolName`. Filled by `.guren/agents.gen.ts`. */
// oxlint-disable-next-line typescript/no-empty-object-type -- an augmentation target, filled by codegen
export interface AppAgentTools {}

/** Provider names from `config/ai.ts`: `interface AiProviders extends InferProviders<typeof config> {}`. */
// oxlint-disable-next-line typescript/no-empty-object-type -- an augmentation target, filled by the app
export interface AiProviders {}

/** Agent wire names from `app/Ai/agents.ts`. */
// oxlint-disable-next-line typescript/no-empty-object-type -- an augmentation target, filled by the app
export interface AiAgents {}

/** USD per million tokens. Declared here because `config/ai.ts` names it and the eval runner prices with it. */
export interface AiPricing {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

type NamesOf<T> = [keyof T] extends [never] ? string : Extract<keyof T, string>

export type AgentToolName = NamesOf<AppAgentTools>
export type AiProviderName = NamesOf<AiProviders>
export type AiAgentName = NamesOf<AiAgents>

/** The RFC 0016 scope grammar. Only the `tool:` form is exact; a prefix is checked for shape. */
export type AgentToolScope = `tool:${AgentToolName}` | `tools:${string}.*` | 'tools:read' | 'tools:*'

type AppAgentToolField<K extends string, F extends 'input' | 'output'> = K extends keyof AppAgentTools
  ? AppAgentTools[K] extends Record<F, infer T> ? T : unknown
  : unknown

/** A tool's arguments, as `.guren/agents.gen.ts` renders its route contract; `unknown` before codegen. */
export type AgentToolInput<K extends string> = AppAgentToolField<K, 'input'>

/** A tool's success body; `unknown` when the route declares no `output` schema or resolvable `resource` hint. */
export type AgentToolOutput<K extends string> = AppAgentToolField<K, 'output'>

type UngrantedNames<S extends readonly string[], N extends readonly string[]> = {
  [I in keyof N]: `tool:${N[I]}` extends S[number] ? never : N[I]
}[number]

/**
 * `N` when every name has a `tool:` entry in `S`, otherwise a tuple type that
 * names the ungranted ones in the compile error. Settles nothing when `S` is
 * widened or holds a prefix, `tools:read` or `tools:*` grant: those depend on
 * the derived tool list, which `as()` checks at construction (RFC 0029 §2.2).
 */
export type Granted<S extends readonly string[], N extends readonly string[]> = string extends S[number]
  ? N
  : [Exclude<S[number], `tool:${string}`>] extends [never]
    ? [UngrantedNames<S, N>] extends [never]
      ? N
      : ReadonlyArray<`${UngrantedNames<S, N>} is not granted by static scopes`>
    : N

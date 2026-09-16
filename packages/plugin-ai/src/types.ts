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

type NamesOf<T> = [keyof T] extends [never] ? string : Extract<keyof T, string>

export type AgentToolName = NamesOf<AppAgentTools>
export type AiProviderName = NamesOf<AiProviders>
export type AiAgentName = NamesOf<AiAgents>

/** The RFC 0016 scope grammar. Only the `tool:` form is exact; a prefix is checked for shape. */
export type AgentToolScope = `tool:${AgentToolName}` | `tools:${string}.*` | 'tools:read' | 'tools:*'

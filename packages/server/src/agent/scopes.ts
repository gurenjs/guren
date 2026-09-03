/**
 * The scope grammar an API token's `abilities` use to reach agent tools
 * (RFC 0016 §5.1). Four forms, and deliberately no more — a consent screen is
 * only useful if a human can read a scope and say which tools it grants:
 *
 * - `tool:<name>`      one tool, by exact name
 * - `tools:read`       every tool whose resolved `readOnlyHint` is true
 * - `tools:*`          every tool
 * - `tools:<prefix>.*` every tool named `<prefix>.…`
 *
 * **Only `tool:` / `tools:` entries are considered**, so a token issued before
 * agent tools existed — holding the store's default `['*']` — grants none of
 * them (default deny). A malformed entry is likewise ignored rather than
 * throwing: this module judges an already-issued token and must grant less,
 * never more; rejecting a bad scope belongs to the issuer, which runs
 * {@link parseToolScope} and refuses a `null`. Matching is case-sensitive and
 * entries are not trimmed — normalizing here would make the judge more
 * permissive than the issuer.
 */

/**
 * The MCP tool-name grammar (SEP-986), which a `tool:` scope names and a
 * `tools:<prefix>.*` scope must stay inside. `packages/cli/src/agent-route-check.ts`
 * holds the same pattern; collapsing the two needs a built server, so it waits
 * for the PR doing that build-order work. `*` is not in the charset, so
 * `tool:posts.*` is rejected with no special case.
 */
export const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/** One well-formed scope entry, discriminated by what it grants. */
export type ParsedToolScope =
  /** `tool:<name>` — exactly the tool with this name. */
  | { kind: 'tool'; name: string }
  /** `tools:read` — every tool whose resolved `readOnlyHint` is true. */
  | { kind: 'read' }
  /** `tools:*` — every tool. */
  | { kind: 'all' }
  /** `tools:<prefix>.*` — every tool named `<prefix>.…`. `prefix` excludes the dot. */
  | { kind: 'prefix'; prefix: string }

/**
 * The shape a tool has to present to be judged: its name, and whether it
 * resolved to read-only. Deliberately not `DerivedAgentTool`, which is
 * structurally compatible via
 * `{ name: tool.toolName, readOnly: tool.annotations.readOnlyHint }`.
 */
export interface ScopedTool {
  name: string
  readOnly: boolean
}

/** `tool:` scope prefix, including the separator. */
const SINGLE_PREFIX = 'tool:'
/** `tools:` scope prefix, including the separator. */
const SET_PREFIX = 'tools:'
/** The reserved `tools:` word granting every read-only tool. */
const READ_KEYWORD = 'read'
/** The reserved `tools:` word granting every tool. */
const ALL_KEYWORD = '*'
/** Wildcard suffix of a prefix scope, dot included. */
const PREFIX_SUFFIX = '.*'

/**
 * Parse one `abilities` entry.
 *
 * @returns The scope it denotes, or `null` both for an entry that is not a tool
 *   scope and for a malformed one (`tools:`, `tools:.*`, `tools:*.store`, a
 *   prefix outside the tool-name grammar). Callers cannot tell those apart on
 *   purpose: both mean "grants no tool".
 *
 * The two reserved `tools:` words are matched before the wildcard form, so a
 * family named `read.…` is still reachable as `tools:read.*` while a tool named
 * exactly `read` is reachable only as `tool:read`.
 */
export function parseToolScope(entry: string): ParsedToolScope | null {
  if (entry.startsWith(SINGLE_PREFIX)) {
    const name = entry.slice(SINGLE_PREFIX.length)
    return AGENT_TOOL_NAME_PATTERN.test(name) ? { kind: 'tool', name } : null
  }

  if (!entry.startsWith(SET_PREFIX)) return null

  const rest = entry.slice(SET_PREFIX.length)
  if (rest === READ_KEYWORD) return { kind: 'read' }
  if (rest === ALL_KEYWORD) return { kind: 'all' }
  if (!rest.endsWith(PREFIX_SUFFIX)) return null

  // `.*` is a suffix, never an infix: `tools:*.store` and `tools:posts.*.x`
  // both fail here. A grammar with an interior wildcard reads as a glob and
  // would need one, which is more matcher than a consent screen can explain.
  const prefix = rest.slice(0, -PREFIX_SUFFIX.length)
  if (!AGENT_TOOL_NAME_PATTERN.test(prefix)) return null
  // A prefix at the length cap can never leave room for `<prefix>.<something>`
  // inside the same cap, so it is legal and matches nothing. Expansion is what
  // shows an issuer that a scope grants an empty list.
  return { kind: 'prefix', prefix }
}

/** Whether one parsed scope covers a given tool. */
function scopeAllowsTool(scope: ParsedToolScope, tool: ScopedTool): boolean {
  switch (scope.kind) {
    case 'tool':
      return scope.name === tool.name
    case 'read':
      return tool.readOnly
    case 'all':
      return true
    case 'prefix':
      // The dot is part of the match: `tools:posts.*` covers `posts.store`
      // and not `posts` itself, which is a different tool with a name that
      // happens to be a prefix of this family's.
      return tool.name.startsWith(`${scope.prefix}.`)
    default: {
      const exhaustive: never = scope
      return exhaustive
    }
  }
}

/**
 * Whether a token's abilities grant a tool. Any one entry suffices — scopes
 * are additive, and there is no deny form.
 */
export function scopesAllowTool(abilities: readonly string[], tool: ScopedTool): boolean {
  for (const entry of abilities) {
    const scope = parseToolScope(entry)
    if (scope && scopeAllowsTool(scope, tool)) return true
  }
  return false
}

/**
 * The concrete tool names a token's abilities grant, for the surfaces that show
 * a human what a scope means: the OAuth consent screen, the `token:issue`
 * confirmation, the issuance-time lint.
 *
 * Literally a filter over {@link scopesAllowTool}, and it must stay one: a
 * second matcher is how a consent screen comes to list a tool the dispatcher
 * then denies.
 *
 * @returns Names in the order the tools were given.
 */
export function expandToolScopes(
  abilities: readonly string[],
  tools: readonly ScopedTool[],
): string[] {
  return tools.filter((tool) => scopesAllowTool(abilities, tool)).map((tool) => tool.name)
}

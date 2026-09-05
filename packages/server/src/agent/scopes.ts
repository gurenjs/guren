/**
 * The scope grammar an API token's `abilities` use to reach agent tools
 * (RFC 0016 §5.1). Four forms, so a human can read a scope on a consent screen:
 * `tool:<name>`, `tools:read` (every tool whose resolved `readOnlyHint` is
 * true), `tools:*`, `tools:<prefix>.*`. **Only `tool:` / `tools:` entries are
 * considered**, so the store's default `['*']` grants no tool (default deny). A
 * malformed entry is ignored, not thrown: this module judges an issued token and
 * must grant less, never more; rejecting belongs to the issuer, which refuses a
 * `null` from {@link parseToolScope}. Case-sensitive and untrimmed, for the same reason.
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
 * Parse one `abilities` entry. The two reserved `tools:` words are matched
 * before the wildcard form, so a family named `read.…` is still reachable as
 * `tools:read.*` while a tool named exactly `read` is only `tool:read`.
 * @returns The scope, or `null` for both a non-tool entry and a malformed one
 *   (`tools:`, `tools:.*`, `tools:*.store`): both mean "grants no tool", on purpose.
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

/**
 * The scope forms a **registration** may declare (RFC 0017 §3): the narrower
 * half of the grammar above, because a registration grants an *unattended*
 * principal and is outlived by the route graph, so a set grant would acquire
 * consent to tools that did not yet exist. One rule, shared with `guren check`.
 */
export type RegistrationScopeVerdict =
  /** The entry is a legal registration scope. */
  | { allowed: true; scope: Extract<ParsedToolScope, { kind: 'tool' } | { kind: 'read' }> }
  /**
   * The entry may not be registered. `message` states the reason and the fix,
   * and is what both the plugin's throw and the check's finding say — so a
   * developer reads the same sentence whichever surface catches it first.
   */
  | { allowed: false; reason: 'wildcard' | 'prefix' | 'not-a-tool-scope'; message: string }

/**
 * Judge one `scopes` entry of an agent registration.
 *
 * @param entry The scope as written in the config.
 */
export function classifyRegistrationScope(entry: string): RegistrationScopeVerdict {
  const scope = parseToolScope(entry)

  if (scope?.kind === 'tool' || scope?.kind === 'read') {
    return { allowed: true, scope }
  }

  if (scope?.kind === 'all') {
    return {
      allowed: false,
      reason: 'wildcard',
      message:
        `"${entry}" grants every tool the application has, including every tool it grows later. `
        + 'An unattended agent must not acquire consent to tools that did not exist when this was '
        + 'written. List the tools as tool:<name> entries, or use tools:read if the agent only reads.',
    }
  }

  if (scope?.kind === 'prefix') {
    return {
      allowed: false,
      reason: 'prefix',
      message:
        `"${entry}" grants every tool in the ${scope.prefix}.* family, including ones added later. `
        + 'An unattended agent must not acquire consent to tools that did not exist when this was '
        + 'written. List the tools it needs as tool:<name> entries.',
    }
  }

  // A bare name is the mistake worth naming a fix for; a malformed `tool:`/
  // `tools:` entry already knows it is trying to be a scope, and guessing a
  // correction for it would as often be wrong as right.
  const suggestion = AGENT_TOOL_NAME_PATTERN.test(entry) ? ` Did you mean "tool:${entry}"?` : ''

  return {
    allowed: false,
    reason: 'not-a-tool-scope',
    message:
      `"${entry}" is not a tool scope, so it grants nothing. The registration grammar is `
      + 'tool:<name> for one tool by exact name, or tools:read for every read-only tool.'
      + suggestion,
  }
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
 * confirmation, the issuance-time lint. Literally a filter over
 * {@link scopesAllowTool}, and it must stay one: a second matcher is how a
 * consent screen comes to list a tool the dispatcher then denies. Order of `tools`.
 */
export function expandToolScopes(
  abilities: readonly string[],
  tools: readonly ScopedTool[],
): string[] {
  return tools.filter((tool) => scopesAllowTool(abilities, tool)).map((tool) => tool.name)
}

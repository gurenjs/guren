/**
 * The scope grammar an API token's `abilities` use to reach agent tools
 * (RFC 0016 §5.1).
 *
 * Four forms, and deliberately no more — a grammar an agent-facing consent
 * screen has to render is only useful if a human can read a scope and say
 * which tools it grants:
 *
 * - `tool:<name>`      one tool, by exact name
 * - `tools:read`       every tool whose resolved `readOnlyHint` is true
 * - `tools:*`          every tool
 * - `tools:<prefix>.*` every tool named `<prefix>.…`
 *
 * **Only `tool:` / `tools:` entries are considered.** Every other ability an
 * `ApiToken` carries — including the store's default `['*']` — is ignored, so
 * it matches nothing. This is the fail-closed half of a deliberate split:
 *
 * - A token issued before agent tools existed, for an app's own API, holds
 *   `['*']`. Reading that as "all agent tools" would silently hand every
 *   already-issued token the whole agent surface the moment an app declares
 *   its first `.agent()` route. Access to the agent surface is granted by an
 *   explicit tool scope or not at all (default deny, RFC §5.1); `tools:*` is
 *   the explicit way to say "everything".
 * - A malformed entry is likewise ignored here rather than throwing: this
 *   module judges an already-issued token, and a token that cannot be parsed
 *   must grant less, never more. Rejecting a bad scope belongs to the
 *   *issuer* (`token:issue`, a later PR), which runs {@link parseToolScope}
 *   over what it was asked for and refuses a `null`.
 *
 * Matching is case-sensitive and entries are not trimmed. A stored ability
 * with stray whitespace is an issuance bug; normalizing it here would make
 * the judge more permissive than the issuer, which is the wrong direction.
 */

/**
 * The MCP tool-name grammar (SEP-986), which a `tool:` scope names and a
 * `tools:<prefix>.*` scope has to stay inside — a scope that could not
 * possibly name a legal tool is not a scope.
 *
 * `packages/cli/src/agent-route-check.ts` holds the same pattern for the
 * check that fails a build over an illegal tool name. Collapsing the two onto
 * this export is a later change, not this one: the CLI reaches `@guren/server`
 * through `dist/`, so the collapse needs a built server and belongs with the
 * PR that does the build-order work.
 *
 * Note what the charset gives for free: `*` is not in it, so `tool:posts.*`
 * fails the test and needs no special case to be rejected.
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
 * resolved to read-only. Deliberately not `DerivedAgentTool` — the token
 * guard, the consent screen and a test fixture all supply this, and none of
 * them should have to build a whole derived tool to ask a question about two
 * fields. `DerivedAgentTool` is structurally compatible via
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
 * @returns The scope it denotes, or `null` for an entry that is not a tool
 *   scope at all (`'*'`, an app's own ability name) and for one that is
 *   malformed (`tools:`, `tools:.*`, `tools:*.store`, a prefix outside the
 *   tool-name grammar). Callers cannot tell those apart on purpose: both mean
 *   "grants no tool", and a judge that distinguished them would be inventing
 *   a third answer for a two-valued question.
 *
 * Note the two reserved `tools:` words are matched before the wildcard form,
 * so a tool family literally named `read.…` is still reachable as
 * `tools:read.*`, while a tool named exactly `read` is reachable only as
 * `tool:read` — the reserved word wins its own spelling.
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
  // inside the same cap, so it is legal and matches nothing. Left legal
  // rather than rejected: expansion is what shows an issuer that a scope
  // grants an empty list, and one place saying so beats two.
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
 * The concrete tool names a token's abilities grant, for the surfaces that
 * have to show a human what a scope means: the OAuth consent screen, the
 * `token:issue` confirmation, and the issuance-time lint.
 *
 * Literally a filter over {@link scopesAllowTool}, and it must stay one. A
 * second matcher that walked entries and accumulated names is how a consent
 * screen comes to list a tool the dispatcher then denies — the two answers
 * have to be the same answer, not two implementations of one rule.
 *
 * @returns Names in the order the tools were given, so a caller controls the
 *   display order by ordering its input.
 */
export function expandToolScopes(
  abilities: readonly string[],
  tools: readonly ScopedTool[],
): string[] {
  return tools.filter((tool) => scopesAllowTool(abilities, tool)).map((tool) => tool.name)
}

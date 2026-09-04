/**
 * `guren token:issue` — mint an API token scoped to this app's agent tools (RFC 0016 §5.1).
 *
 * The *issuer* half of the split `agent/scopes.ts` describes: that module judges an issued
 * token and grants less on anything it cannot parse, while here the same entry is a typo a
 * human is still looking at, so everything below fails at issuance rather than at dispatch.
 * A scope matching no current tool is rejected as a typo or a latent grant that would
 * activate without consent (`--allow-unmatched` overrides). `--read-only` stores concrete
 * `tool:<name>` entries, never the pattern, which is fail-closed. Scope expansion goes
 * through `expandToolScopes` alone, or an issuance screen lists tools the dispatcher denies.
 */
import { consola } from 'consola'
import {
  createApiToken,
  expandToolScopes,
  parseToolScope,
  type ApiTokenStore,
  type CreateApiTokenResult,
  type ScopedTool,
} from '@guren/core'
import { listTools } from './tool-list'
import { loadBootedApplication } from './runtime'

/** `tool:` scope prefix, including the separator. */
const SINGLE_PREFIX = 'tool:'
/** `tools:` scope prefix, including the separator. */
const SET_PREFIX = 'tools:'

/** Milliseconds per `--expires` unit. */
const DURATION_UNITS: Record<string, number> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
}

const DURATION_PATTERN = /^(\d+)([dhm])$/

/**
 * The longest expiry still inside the ECMAScript Date range (±100,000,000 days from the
 * epoch) from any plausible `now` — half the range, with room to spare.
 */
const MAX_EXPIRES_DAYS = 36_500_000
const MAX_EXPIRES_MS = MAX_EXPIRES_DAYS * DURATION_UNITS.d!

/**
 * Expand a shorthand `--tools` entry to full scope syntax. An entry already naming a
 * prefix passes through verbatim, malformed ones included ({@link parseToolScope} rejects
 * them by name) — rewriting one would be the issuer guessing at intent.
 */
export function normalizeToolScope(entry: string): string {
  if (entry.startsWith(SINGLE_PREFIX) || entry.startsWith(SET_PREFIX)) return entry
  if (entry === '*') return `${SET_PREFIX}*`
  if (entry === 'read') return `${SET_PREFIX}read`
  if (entry.endsWith('.*')) return `${SET_PREFIX}${entry}`
  return `${SINGLE_PREFIX}${entry}`
}

/**
 * Parse a `--expires` duration (`30d` / `12h` / `45m`) into milliseconds. Zero is refused
 * rather than read as "expires now", and the upper bound refuses the same failure from
 * the other end (past the Date range, `now + expiresIn` is an Invalid Date, which every
 * expiry check reads as expired). Both fail closed at the store; refusing here keeps the
 * success message from being false.
 */
export function parseExpiresDuration(value: string): number {
  const match = DURATION_PATTERN.exec(value)
  if (match) {
    const amount = Number(match[1])
    const milliseconds = amount * DURATION_UNITS[match[2]!]!
    if (Number.isSafeInteger(amount) && amount > 0 && milliseconds <= MAX_EXPIRES_MS) {
      return milliseconds
    }
  }

  throw new Error(
    `Invalid --expires value "${value}". Use a positive amount followed by d, h, or m (for example 30d, 12h, 45m)`
      + `, up to ${MAX_EXPIRES_DAYS}d.`,
  )
}

/**
 * Read `--user` as the identifier the app's user provider will look up. A digits-only
 * value becomes a number, since `retrieveById` hands it straight to `Model.find` against
 * a serial key; anything else (a UUID, a ULID) stays a string.
 */
export function parseUserId(value: string): string | number {
  // Round-trip rather than digits-only: `0042` and `42` are different ids in an app keyed
  // by string, and coercing one to the other mints a token for a principal nobody typed.
  const numeric = Number(value)
  return /^\d+$/.test(value) && Number.isSafeInteger(numeric) && String(numeric) === value
    ? numeric
    : value
}

export interface TokenIssueInput {
  /** Raw `--tools` value: comma-separated scopes, shorthand or full syntax. */
  tools: string
  /** Restrict the grant to read-only tools, stored as concrete entries. */
  readOnly?: boolean
  /** Accept a scope that matches no current tool, as a future grant. */
  allowUnmatched?: boolean
  /** Required to accept `tools:*`. */
  yes?: boolean
  /** `--expires` duration, or undefined for a non-expiring token. */
  expires?: string
}

export interface TokenIssuePlan {
  /** Ability entries stored on the token, in the order they were given. */
  abilities: string[]
  /** The concrete tools granted at issuance, split by resolved `readOnlyHint`. */
  granted: { readOnly: string[]; write: string[] }
  /** Milliseconds until expiry, or `null` for a token that never expires. */
  expiresIn: number | null
  /** Issuance-time advisories. Never a substitute for a refusal. */
  warnings: string[]
}

/** Split, trim, and drop empties — `--tools 'a, b,'` names two scopes. */
function splitToolEntries(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Decide what a token would carry, without minting anything. Throws on every refusal in a
 * fixed order, so the first thing wrong with a command line is the thing reported: parse,
 * `tools:*` consent, unmatched scopes, the `--read-only` intersection, `--expires`.
 * `tools` is injected rather than derived so the rules stay testable with no route graph.
 */
export function planTokenIssue(input: TokenIssueInput, tools: readonly ScopedTool[]): TokenIssuePlan {
  const entries = splitToolEntries(input.tools)
  if (entries.length === 0) {
    throw new Error('--tools requires at least one scope (for example: tools:read, posts.*, posts.store).')
  }

  // Caller's order, exact repeats dropped: a duplicate grants nothing and only makes the
  // stored abilities harder to read.
  const normalized: string[] = []
  for (const entry of entries) {
    const scope = normalizeToolScope(entry)
    if (parseToolScope(scope) === null) {
      throw new Error(
        `Invalid tool scope "${entry}"${scope === entry ? '' : ` (read as "${scope}")`}. `
          + 'Use tool:<name>, tools:read, tools:*, or tools:<prefix>.* — names may contain letters, digits, dot, dash and underscore.',
      )
    }
    if (!normalized.includes(scope)) normalized.push(scope)
  }

  if (normalized.includes(`${SET_PREFIX}*`) && !input.yes) {
    throw new Error(
      'tools:* grants every agent tool this app exposes now and every one it gains later, '
        + 'including destructive ones. Re-run with --yes to issue it, or name the tools you meant.',
    )
  }

  const warnings: string[] = []

  // `read` is a reserved word before it is a tool name, so an app naming a tool `read`
  // cannot reach it through the shorthand — nothing is broadened, but the two readings
  // look identical on a command line. Read from `entries` as typed: an explicit
  // `tools:read` normalizes to the same entry and its author has no ambiguity.
  if (entries.includes('read') && tools.some((tool) => tool.name === 'read')) {
    warnings.push(
      'The shorthand "read" means tools:read — every read-only tool — not the tool named "read". '
        + 'Write tool:read to grant that one tool.',
    )
  }

  // What an entry may count as a match against. Under `--read-only` that is the
  // read-only tools alone, so a scope resolving only to write tools is reported as the
  // mistake it is rather than contributing nothing silently.
  const readOnlyTools = tools.filter((tool) => tool.readOnly)
  const readOnlyNames = new Set(readOnlyTools.map((tool) => tool.name))
  const matchable = input.readOnly ? readOnlyTools : tools

  for (const scope of normalized) {
    if (expandToolScopes([scope], matchable).length > 0) continue

    if (input.readOnly) {
      // Refused even under --allow-unmatched: that flag promises future activation, and a
      // read-only token stores concrete `tool:` entries, which can never gain members.
      throw new Error(
        `Scope "${scope}" matches no read-only tool this app exposes, and --read-only stores concrete `
          + 'tool: entries, so it could never grant anything later either. Drop it, or issue without --read-only.',
      )
    }

    if (!input.allowUnmatched) {
      throw new Error(
        `Scope "${scope}" matches none of this app's agent tools. `
          + 'Check the name against `guren tool:list`, or pass --allow-unmatched to grant it for tools added later.',
      )
    }

    warnings.push(
      `Scope "${scope}" matches no tool today. It will activate automatically, with no further consent, `
        + 'as soon as a tool matching it is added.',
    )
  }

  // Every surviving entry matched at least one tool in `matchable`, so this is never
  // empty — a read-only token that can call nothing was refused above, per entry.
  const grantedNames = expandToolScopes(normalized, matchable)

  const granted = {
    readOnly: grantedNames.filter((name) => readOnlyNames.has(name)),
    write: grantedNames.filter((name) => !readOnlyNames.has(name)),
  }

  const abilities = input.readOnly
    ? grantedNames.map((name) => `${SINGLE_PREFIX}${name}`)
    : normalized

  const expiresIn = input.expires === undefined ? null : parseExpiresDuration(input.expires)

  if (expiresIn === null) {
    warnings.push(
      'This token never expires. A leaked non-expiring token stays valid until someone revokes it by hand — '
        + 'pass --expires 30d unless you have a reason not to.',
    )
  }

  if (granted.readOnly.length > 0 && granted.write.length > 0) {
    // One principal that can read attacker-influenced content and also write. A warning,
    // not a refusal — plenty of legitimate agents need both.
    warnings.push(
      'This token grants both read and write tools. An agent that reads untrusted content and can also write '
        + 'it back can be steered by that content (the Supabase-incident shape) — split the two across separate tokens if you can.',
    )
  }

  return { abilities, granted, expiresIn, warnings }
}

/**
 * Plan, then mint. The store arrives as a thunk resolved only once the plan holds:
 * reaching it means booting the app, database and all, and a misspelled `--tools` entry
 * should cost nothing more than the message naming it.
 */
export async function issueAgentToken(
  resolveStore: () => ApiTokenStore | Promise<ApiTokenStore>,
  tools: readonly ScopedTool[],
  input: TokenIssueInput & { name: string; userId: string | number },
): Promise<{ plan: TokenIssuePlan; result: CreateApiTokenResult }> {
  // citty's `required: true` is satisfied by `--user ''`, which resolves to no user at
  // all — a token authenticating as nobody that only says so at dispatch. A nameless
  // token is likewise unrevocable in practice: nothing in a token list identifies it.
  if (String(input.userId).trim() === '') {
    throw new Error('--user requires a user ID; an empty one would issue a token that authenticates as nobody.')
  }
  if (input.name.trim() === '') {
    throw new Error('--name requires a non-empty name; it is how this token is identified when someone revokes it.')
  }

  const plan = planTokenIssue(input, tools)
  const store = await resolveStore()

  const result = await createApiToken(store, {
    name: input.name,
    userId: input.userId,
    abilities: plan.abilities,
    expiresIn: plan.expiresIn,
  })

  return { plan, result }
}

export interface TokenIssueOptions extends TokenIssueInput {
  name: string
  user: string
  routesFile?: string
  appRoot?: string
  json?: boolean
}

/**
 * Load the application and hand back the store it configured, or explain how to configure
 * one. `MaybeApplication` is structural rather than an `AuthManager` import: an app on an
 * older `@guren/core` has no accessor, and must land on the message below, not a TypeError.
 */
async function resolveApiTokenStore(appRoot?: string): Promise<ApiTokenStore> {
  // The same root the tool list was derived from, and booted or nothing: a token written
  // into a half-booted app is issued against a store that never finished configuring.
  const app = await loadBootedApplication(appRoot)

  const store = app.auth?.getApiTokenStore?.()
  if (!store) {
    throw new Error(
      'This application has no API token store, so there is nowhere to write a token. '
        + 'Call auth.useTokens(store) in the app\'s auth configuration (for example from a service provider) and run this again.',
    )
  }

  return store
}

/** The tools the scope matcher judges against, derived live from the routes. */
async function loadScopedTools(options: TokenIssueOptions): Promise<{ tools: ScopedTool[]; warnings: string[] }> {
  const { tools, warnings } = await listTools({ routesFile: options.routesFile, appRoot: options.appRoot })
  return {
    // Only tools exposed on MCP: bearer is how the App MCP endpoint authenticates, and
    // the other surfaces do not read these tokens (WebMCP carries the session, `tool:call`
    // takes `--as`). Counting an `expose: { mcp: false }` tool would print a grant no
    // dispatcher honours and let a `--read-only` intersection pass on an uncallable tool.
    tools: tools
      .filter((tool) => tool.expose.mcp)
      .map((tool) => ({ name: tool.toolName, readOnly: tool.annotations.readOnlyHint })),
    warnings,
  }
}

export async function runTokenIssue(options: TokenIssueOptions): Promise<void> {
  // Derivation first: a bad `--tools` or an app with no agent routes is reported without
  // booting the application (and its database) at all.
  const { tools, warnings: derivationWarnings } = await loadScopedTools(options)

  if (tools.length === 0) {
    throw new Error(
      'This app exposes no agent tools, so a tool-scoped token would grant nothing. '
        + 'Declare .agent() on a named route first — `guren tool:list` shows what is exposed.',
    )
  }

  const { plan, result } = await issueAgentToken(() => resolveApiTokenStore(options.appRoot), tools, {
    ...options,
    userId: parseUserId(options.user),
  })

  if (options.json) {
    // One JSON object on stdout and nothing beside it — warnings ride inside the payload,
    // since a consola line would make the output unparseable for callers passing --json.
    console.log(
      JSON.stringify(
        {
          token: result.plainTextToken,
          id: result.token.id,
          name: result.token.name,
          userId: result.token.userId,
          abilities: plan.abilities,
          granted: plan.granted,
          expiresAt: result.token.expiresAt?.toISOString() ?? null,
          warnings: [...derivationWarnings, ...plan.warnings],
        },
        null,
        2,
      ),
    )
    return
  }

  for (const warning of derivationWarnings) consola.warn(warning)

  consola.success(`Issued token "${result.token.name}" for user ${String(result.token.userId)}.`)
  console.log('')
  console.log('\x1b[1mToken\x1b[0m (shown once — it is stored hashed and cannot be recovered)')
  console.log(`  ${result.plainTextToken}`)
  console.log('')
  console.log(`\x1b[1mExpires\x1b[0m  ${result.token.expiresAt ? result.token.expiresAt.toISOString() : 'never'}`)
  console.log(`\x1b[1mAbilities\x1b[0m  ${plan.abilities.join(', ')}`)
  console.log('')
  console.log('\x1b[1mGranted tools\x1b[0m')
  printGrantedGroup('read', plan.granted.readOnly)
  printGrantedGroup('write', plan.granted.write)

  if (plan.warnings.length > 0) {
    console.log('')
    for (const warning of plan.warnings) consola.warn(warning)
  }
}

function printGrantedGroup(label: string, names: string[]): void {
  if (names.length === 0) {
    console.log(`  ${label}: (none)`)
    return
  }
  console.log(`  ${label}: ${names.join(', ')}`)
}

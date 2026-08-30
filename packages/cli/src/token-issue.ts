/**
 * `guren token:issue` — mint an API token scoped to this app's agent tools
 * (RFC 0016 §5.1).
 *
 * The command is the *issuer* half of the split `agent/scopes.ts` describes:
 * that module judges an already-issued token and must grant less on anything
 * it cannot parse, so it silently ignores a malformed entry. Here the same
 * entry is a typo in a command line a human is still looking at, and the only
 * useful answer is to refuse and name it. Everything below exists to fail at
 * issuance rather than to fail quietly at dispatch:
 *
 * - a scope that parses but matches no current tool is rejected, because it is
 *   either a typo or a *latent grant* — a stored pattern that would activate
 *   without anyone's consent the moment a matching tool is added. Overriding
 *   that (`--allow-unmatched`) is deliberate and warns about exactly that.
 * - `--read-only` stores the concrete `tool:<name>` entries it resolved to,
 *   never the pattern. That asymmetry is forced by the grammar, not taste:
 *   `ParsedToolScope` has no "read-only subset of `posts.*`" form, so a
 *   concrete list is the only faithful encoding — and it is fail-closed, since
 *   a write tool added later to the `posts.` family joins no stored entry.
 *
 * Scope expansion goes through `expandToolScopes` and nothing else, once per
 * entry for the unmatched rule and once over the whole list for the grant.
 * A second accumulator here is precisely what that module's header warns
 * against: an issuance screen listing tools the dispatcher then denies.
 */
import { consola } from 'consola'
import { pathToFileURL } from 'node:url'
import {
  createApiToken,
  expandToolScopes,
  parseToolScope,
  type ApiTokenStore,
  type CreateApiTokenResult,
  type ScopedTool,
} from '@guren/core'
import { listTools } from './tool-list'
import {
  bootstrapApplication,
  ensureApplicationBooted,
  resolveMainEntry,
  type MaybeApplication,
} from './runtime'

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
 * Expand a shorthand `--tools` entry to full scope syntax.
 *
 * An entry that already names a prefix is passed through verbatim — including
 * a malformed one like `tool:posts.*`, which {@link parseToolScope} then
 * rejects by name. Rewriting it into something legal would be the issuer
 * guessing at intent, and a guess is what a scope grammar cannot afford.
 */
export function normalizeToolScope(entry: string): string {
  if (entry.startsWith(SINGLE_PREFIX) || entry.startsWith(SET_PREFIX)) return entry
  if (entry === '*') return `${SET_PREFIX}*`
  if (entry === 'read') return `${SET_PREFIX}read`
  if (entry.endsWith('.*')) return `${SET_PREFIX}${entry}`
  return `${SINGLE_PREFIX}${entry}`
}

/**
 * Parse a `--expires` duration (`30d` / `12h` / `45m`) into milliseconds.
 *
 * Zero is refused rather than accepted as "expires now": `createApiToken`
 * stores `now + expiresIn` unguarded, so `0m` would mint a token that is
 * already dead — a silent no-op wearing the shape of a successful issuance.
 */
export function parseExpiresDuration(value: string): number {
  const match = DURATION_PATTERN.exec(value)
  const amount = match ? Number(match[1]) : NaN

  if (!match || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(
      `Invalid --expires value "${value}". Use a positive amount followed by d, h, or m (for example 30d, 12h, 45m).`,
    )
  }

  return amount * DURATION_UNITS[match[2]!]!
}

/**
 * Read `--user` as the identifier the app's user provider will look up.
 *
 * A digits-only value becomes a number, because that is what a serial primary
 * key is and `retrieveById` hands the value straight to `Model.find` — a
 * string there is a type mismatch the database, not this command, would
 * report. Anything else (a UUID, a ULID) stays a string.
 */
export function parseUserId(value: string): string | number {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value
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
 * Decide what a token would carry, without minting anything.
 *
 * Throws on every refusal, in a fixed order so the first thing wrong with a
 * command line is the thing reported: parse, then `tools:*` consent, then
 * unmatched scopes, then the `--read-only` intersection, then `--expires`.
 *
 * @param tools Every tool the app currently exposes, as the scope matcher
 *   sees them. Injected rather than derived here so the rules stay testable
 *   without a route graph on disk.
 */
export function planTokenIssue(input: TokenIssueInput, tools: readonly ScopedTool[]): TokenIssuePlan {
  const entries = splitToolEntries(input.tools)
  if (entries.length === 0) {
    throw new Error('--tools requires at least one scope (for example: tools:read, posts.*, posts.store).')
  }

  // Keep the caller's order and drop exact repeats: a duplicated entry grants
  // nothing extra, and listing it twice in the stored abilities only makes the
  // token harder to read.
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

  // The tools an entry is allowed to count as a match against. Under
  // `--read-only` that is the read-only ones alone, which makes the per-entry
  // rule below say exactly what the token will end up granting: a scope
  // resolving only to write tools contributes nothing to a read-only token,
  // and is as much a mistake as a misspelled name.
  const readOnlyNames = new Set(tools.filter((tool) => tool.readOnly).map((tool) => tool.name))
  const matchable = input.readOnly ? tools.filter((tool) => tool.readOnly) : tools

  for (const scope of normalized) {
    if (expandToolScopes([scope], matchable).length > 0) continue

    if (input.readOnly) {
      // Refused even under --allow-unmatched: that flag's whole promise is
      // future activation, and a read-only token stores concrete `tool:`
      // entries, so this scope could never grant anything at any later point.
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

  // Every surviving entry matched at least one tool in `matchable`, so this is
  // never empty — the "a --read-only token that can call nothing" case is
  // already refused above, by the entry that caused it rather than in the
  // aggregate.
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
    // The lethal trifecta, in the shape the Supabase incident took: one
    // principal that can read attacker-influenced content and also write.
    // A warning, not a refusal — plenty of legitimate agents need both.
    warnings.push(
      'This token grants both read and write tools. An agent that reads untrusted content and can also write '
        + 'it back can be steered by that content (the Supabase-incident shape) — split the two across separate tokens if you can.',
    )
  }

  return { abilities, granted, expiresIn, warnings }
}

/**
 * Plan, then mint.
 *
 * The store arrives as a *thunk*, and is resolved only once the plan holds:
 * reaching an app's store means booting the app, database and all, and a
 * misspelled `--tools` entry should cost nothing more than the message that
 * names it. The tool list is a parameter for the same reason the store is a
 * thunk — the rules above are exercised against a `MemoryApiTokenStore` with
 * no app on disk at all.
 */
export async function issueAgentToken(
  resolveStore: () => ApiTokenStore | Promise<ApiTokenStore>,
  tools: readonly ScopedTool[],
  input: TokenIssueInput & { name: string; userId: string | number },
): Promise<{ plan: TokenIssuePlan; result: CreateApiTokenResult }> {
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
 * Load the application the way `guren console` does and hand back the store it
 * configured, or explain how to configure one.
 *
 * `MaybeApplication` is extended structurally rather than by importing
 * `AuthManager`: an app resolving an older `@guren/core` has no accessor at
 * all, and that must land on the message below instead of a `TypeError`.
 */
async function resolveApiTokenStore(): Promise<ApiTokenStore> {
  const entry = await resolveMainEntry()

  let moduleExports: Record<string, unknown>
  try {
    moduleExports = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `Failed to import application entry (${entry}): ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const app: MaybeApplication = await bootstrapApplication(moduleExports)
  await ensureApplicationBooted(app, moduleExports)

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
    tools: tools.map((tool) => ({ name: tool.toolName, readOnly: tool.annotations.readOnlyHint })),
    warnings,
  }
}

export async function runTokenIssue(options: TokenIssueOptions): Promise<void> {
  // Derivation first: a bad `--tools` or an app with no agent routes should be
  // reported without booting the application (and its database) at all.
  const { tools, warnings: derivationWarnings } = await loadScopedTools(options)

  if (tools.length === 0) {
    throw new Error(
      'This app exposes no agent tools, so a tool-scoped token would grant nothing. '
        + 'Declare .agent() on a named route first — `guren tool:list` shows what is exposed.',
    )
  }

  const { plan, result } = await issueAgentToken(resolveApiTokenStore, tools, {
    ...options,
    userId: parseUserId(options.user),
  })

  if (options.json) {
    // One JSON object on stdout and nothing beside it: the warnings ride
    // inside the payload, because a consola line next to it would make the
    // output unparseable for exactly the callers that pass this flag.
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

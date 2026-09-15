/**
 * The app's declared environment as the CLI reads it (RFC 0027 §7): `guren
 * env:example` writes `.env.example` from it, `guren check --env` compares the
 * two, and `guren plugin` adds a manifest's keys to it. The schema is imported
 * rather than read from source, so a builder chain means here what it means at boot.
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { check, type CheckResult } from './check-result'
import { formatTruncatedList, readIfExists } from './discovery'
import { addCreateAppOption, ensureNamedImports, PATCH_REASONS } from './patch-helpers'
import { applyEnvEntries, envFileKeys, ENV_KEY_PATTERN, type GurenPluginEnvEntry } from './plugin-manifest'

export const ENV_SCHEMA_FILE = 'config/env.ts'
export const ENV_EXAMPLE_FILE = '.env.example'

/** What the CLI reads off an `EnvVar`. Duck-typed: the app's `@guren/core` is not this process's copy. */
export interface DeclaredEnvVar {
  readonly type: string
  readonly presence: string
  readonly defaultValue?: unknown
  readonly choices?: readonly string[]
  readonly isSecret: boolean
  readonly description?: string
}

export type DeclaredEnvVars = Readonly<Record<string, DeclaredEnvVar>>

export type EnvSchemaLoad =
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable'; readonly message: string }
  | { readonly status: 'loaded'; readonly vars: DeclaredEnvVars }

export async function loadEnvSchema(cwd: string): Promise<EnvSchemaLoad> {
  if ((await readIfExists(cwd, ENV_SCHEMA_FILE)) === null) return { status: 'absent' }

  let exported: unknown
  try {
    exported = ((await import(pathToFileURL(resolve(cwd, ENV_SCHEMA_FILE)).href)) as { default?: unknown }).default
  } catch (error) {
    return { status: 'unreadable', message: `${ENV_SCHEMA_FILE} failed to import: ${error instanceof Error ? error.message : String(error)}` }
  }

  const schema = exported as { parse?: unknown; vars?: unknown } | null | undefined
  if (typeof schema?.parse !== 'function' || typeof schema.vars !== 'object' || schema.vars === null) {
    return { status: 'unreadable', message: `${ENV_SCHEMA_FILE} does not default-export a defineEnv() schema.` }
  }
  // A @guren/core older than RFC 0027 Part 2a declares variables that do not report how.
  if (Object.values(schema.vars).some((spec) => typeof (spec as { presence?: unknown }).presence !== 'string')) {
    return { status: 'unreadable', message: `${ENV_SCHEMA_FILE} was declared with a @guren/core too old to report its variables. Upgrade @guren/core.` }
  }
  return { status: 'loaded', vars: schema.vars as DeclaredEnvVars }
}

/** A dotenv value: bare when it survives unquoted, single-quoted so `${...}` is not expanded otherwise. */
function envFileValue(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return ''
  const text = String(value)
  if (/^[\w.:/@+-]*$/u.test(text)) return text
  return text.includes("'") ? JSON.stringify(text) : `'${text}'`
}

function envComment(spec: DeclaredEnvVar): string | undefined {
  const choices = spec.choices?.join(', ')
  if (choices === undefined) return spec.description
  return spec.description ? `${spec.description} (one of: ${choices})` : `One of: ${choices}`
}

/** One `.env.example` entry per declared key, in schema order. A secret's default is never written. */
export function envExampleEntries(vars: DeclaredEnvVars): GurenPluginEnvEntry[] {
  return Object.entries(vars).map(([key, spec]) => {
    const comment = envComment(spec)
    return {
      key,
      value: spec.isSecret ? '' : envFileValue(spec.defaultValue),
      ...(comment ? { comment } : {}),
    }
  })
}

export interface EnvExampleWrite {
  readonly added: string[]
  /** Keys `.env.example` assigns that the schema does not declare; left in place. */
  readonly undeclared: string[]
}

/** Appends the keys `.env.example` lacks. A line it already has is the app's, so it is kept as written. */
export async function writeEnvExample(cwd: string, vars: DeclaredEnvVars): Promise<EnvExampleWrite> {
  const listed = envFileKeys((await readIfExists(cwd, ENV_EXAMPLE_FILE)) ?? '')
  const entries = envExampleEntries(vars)
  await applyEnvEntries(entries, cwd, { files: [ENV_EXAMPLE_FILE] })

  return {
    added: entries.map((entry) => entry.key).filter((key) => !listed.has(key)),
    undeclared: [...listed].filter((key) => !Object.hasOwn(vars, key)),
  }
}

/** `guren check --env`: `.env.example` and `config/env.ts` name the same keys. Content-activated. */
export async function checkEnvExample(cwd: string): Promise<CheckResult[]> {
  const title = 'Environment example'
  const schema = await loadEnvSchema(cwd)
  if (schema.status === 'absent') return []
  if (schema.status === 'unreadable') {
    return [check('env-example', title, 'warn', `${schema.message} ${ENV_EXAMPLE_FILE} was not compared.`, undefined, ENV_SCHEMA_FILE)]
  }

  const declared = Object.keys(schema.vars)
  const listed = envFileKeys((await readIfExists(cwd, ENV_EXAMPLE_FILE)) ?? '')
  const missing = declared.filter((key) => !listed.has(key))
  const undeclared = [...listed].filter((key) => !Object.hasOwn(schema.vars, key))

  if (missing.length === 0 && undeclared.length === 0) {
    return [check('env-example', title, 'pass', `${ENV_EXAMPLE_FILE} lists the ${declared.length} keys ${ENV_SCHEMA_FILE} declares.`)]
  }

  const disagreements = [
    ...(missing.length > 0 ? [`${ENV_EXAMPLE_FILE} is missing ${formatTruncatedList(missing)}`] : []),
    ...(undeclared.length > 0 ? [`${ENV_SCHEMA_FILE} does not declare ${formatTruncatedList(undeclared)}`] : []),
  ]
  const suggestion = missing.length > 0
    ? 'Run `bunx guren env:example` to append the missing keys.'
    : `Declare each key in ${ENV_SCHEMA_FILE}, or remove its line from ${ENV_EXAMPLE_FILE}.`
  return [check('env-example', title, 'fail', `${disagreements.join('; ')}.`, suggestion, ENV_EXAMPLE_FILE)]
}

/** A TypeScript string literal in the scaffolds' quote style; manifest text is untrusted, so everything is escaped. */
function tsString(text: string): string {
  return `'${JSON.stringify(text).slice(1, -1).replace(/\\"/gu, '"').replace(/'/gu, "\\'")}'`
}

/** The `defineEnv({...})` value a manifest entry declares; `assertEnvEntriesAllowed` has validated it. */
export function envEntrySchemaSource(entry: GurenPluginEnvEntry): string {
  const type = entry.type ?? 'string'
  let source = type === 'enum' ? `Env.enum([${(entry.choices ?? []).map(tsString).join(', ')}])` : `Env.${type}()`
  if (entry.default !== undefined) {
    source += `.default(${typeof entry.default === 'string' ? tsString(entry.default) : String(entry.default)})`
  } else if (!entry.required) {
    source += '.optional()'
  }
  if (entry.secret) source += '.secret()'
  if (entry.comment) source += `.describe(${tsString(entry.comment)})`
  return source
}

export interface EnvDeclarationResult {
  readonly updated: boolean
  /** Keys that could not be inserted: the file has no `defineEnv({...})` call to patch. */
  readonly unpatched: string[]
}

/**
 * Declares a plugin's env keys in `config/env.ts` (RFC 0027 §1), so the app's
 * schema stays the complete one. A key already declared keeps its declaration,
 * and an app with no `config/env.ts` is left as it is.
 */
export async function declareEnvEntries(entries: GurenPluginEnvEntry[]): Promise<EnvDeclarationResult> {
  const cwd = process.cwd()
  if ((await readIfExists(cwd, ENV_SCHEMA_FILE)) === null) return { updated: false, unpatched: [] }

  let updated = false
  const unpatched: string[] = []
  // addCreateAppOption inserts at the top of the object, so reversing keeps manifest order.
  for (const entry of entries.filter((candidate) => ENV_KEY_PATTERN.test(candidate.key ?? '')).reverse()) {
    const result = await addCreateAppOption(ENV_SCHEMA_FILE, entry.key, envEntrySchemaSource(entry), 'defineEnv')
    if (result.modified) updated = true
    else if (result.reason !== PATCH_REASONS.optionAlreadySet) unpatched.unshift(entry.key)
  }

  if (updated) {
    const content = (await readIfExists(cwd, ENV_SCHEMA_FILE)) ?? ''
    await writeFile(resolve(cwd, ENV_SCHEMA_FILE), ensureNamedImports(content, '@guren/core', ['Env']), 'utf8')
  }
  return { updated, unpatched }
}

/**
 * The app's declared environment as the CLI reads it (RFC 0027 §7): `guren
 * env:example` writes `.env.example` from it, `guren check --env` compares the
 * two, and `guren plugin` adds a manifest's keys to it. The schema is imported
 * rather than read from source, so a builder chain means here what it means at boot.
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EnvVar } from '@guren/server'
import { check, type CheckResult } from './check-result'
import { fileExists, formatTruncatedList, readIfExists } from './discovery'
import { ensureNamedImports, insertCallOptions } from './patch-helpers'
import { envEntrySchemaSource } from './plugin-env'
import { appendEnvEntries, envFileKeys, pluginEnvEntries, type GurenPluginEnvEntry } from './plugin-manifest'

export const ENV_SCHEMA_FILE = 'config/env.ts'
export const ENV_EXAMPLE_FILE = '.env.example'

/** Read by shape, never `instanceof`: the app's `@guren/core` is not this process's copy. */
export type DeclaredEnvVars = Readonly<Record<string, Pick<EnvVar<unknown>, 'defaultValue' | 'choices' | 'isSecret' | 'description'>>>

/** The app's own schema, read by shape like its variables: enough to parse, nothing more. */
export interface AppEnvSchema {
  parse(source?: undefined, options?: { mode?: 'report' }): {
    values: object
    unset: ReadonlySet<string>
  }
}

type EnvSchemaLoad =
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable'; readonly message: string }
  | { readonly status: 'loaded'; readonly vars: DeclaredEnvVars; readonly schema: AppEnvSchema }

export async function loadEnvSchema(cwd: string): Promise<EnvSchemaLoad> {
  if (!(await fileExists(cwd, ENV_SCHEMA_FILE))) return { status: 'absent' }

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
  if (Object.values(schema.vars).some((spec) => typeof spec !== 'object' || spec === null || !('defaultValue' in spec))) {
    return { status: 'unreadable', message: `${ENV_SCHEMA_FILE} was declared with a @guren/core too old to report its variables. Upgrade @guren/core.` }
  }
  return { status: 'loaded', vars: schema.vars as DeclaredEnvVars, schema: schema as AppEnvSchema }
}

/**
 * A dotenv value Bun reads back verbatim. Bun expands `$NAME` in every form and
 * reads `\$` as `$`, keeps every other backslash, except `\n` and `\r` inside double
 * quotes, and ends a bare value at `#`. So only `$` is escaped, and a value no form
 * carries (a line break, or `'` together with `\`) is left blank.
 */
function envFileValue(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return ''
  const text = String(value)
  if (/[\r\n]/u.test(text)) return ''
  // Not a backslash escape: Bun keeps `\` as itself, so doubling it would change the value.
  const escaped = [...text].map((char) => (char === '$' ? '\\$' : char)).join('')
  if (/^[\w.:/@+\\$-]*$/u.test(escaped)) return escaped
  if (!text.includes("'") && !text.endsWith('\\')) return `'${escaped}'`
  if (!text.includes('"') && !text.includes('\\')) return `"${escaped}"`
  return ''
}

function envExampleEntries(vars: DeclaredEnvVars): GurenPluginEnvEntry[] {
  return Object.entries(vars).map(([key, spec]) => {
    const choices = spec.choices?.join(', ')
    const comment = choices === undefined
      ? spec.description
      : spec.description ? `${spec.description} (one of: ${choices})` : `One of: ${choices}`
    return { key, value: spec.isSecret ? '' : envFileValue(spec.defaultValue), ...(comment ? { comment } : {}) }
  })
}

async function compareEnvExample(cwd: string, vars: DeclaredEnvVars) {
  const content = await readIfExists(cwd, ENV_EXAMPLE_FILE)
  const listed = envFileKeys(content ?? '')
  return {
    content: content ?? '',
    missing: Object.keys(vars).filter((key) => !listed.has(key)),
    undeclared: [...listed].filter((key) => !Object.hasOwn(vars, key)),
  }
}

/** Appends the keys `.env.example` lacks. A line already there is the app's and stays as written. */
export async function writeEnvExample(cwd: string, vars: DeclaredEnvVars): Promise<{ added: string[]; undeclared: string[] }> {
  const { content, undeclared } = await compareEnvExample(cwd, vars)
  const next = appendEnvEntries(content, envExampleEntries(vars))
  if (next.added.length > 0) await writeFile(resolve(cwd, ENV_EXAMPLE_FILE), next.content, 'utf8')
  return { added: next.added, undeclared }
}

/** `guren check --env`: `.env.example` and `config/env.ts` name the same keys. */
export async function checkEnvExample(cwd: string): Promise<CheckResult[]> {
  const title = 'Environment example'
  const schema = await loadEnvSchema(cwd)
  if (schema.status === 'absent') return []
  if (schema.status === 'unreadable') {
    return [check('env-example', title, 'fail', `${schema.message} ${ENV_EXAMPLE_FILE} was not compared.`, undefined, ENV_SCHEMA_FILE)]
  }

  const { missing, undeclared } = await compareEnvExample(cwd, schema.vars)
  if (missing.length === 0 && undeclared.length === 0) {
    const count = Object.keys(schema.vars).length
    return [check('env-example', title, 'pass', `${ENV_EXAMPLE_FILE} lists the ${count} keys ${ENV_SCHEMA_FILE} declares.`)]
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

/**
 * Declares a plugin's env keys in `config/env.ts` (RFC 0027 §1), so the app's
 * schema stays the complete one. A key already declared keeps its declaration,
 * and an app with no `config/env.ts` is left as it is. `unpatched` names the keys
 * a file with no `defineEnv({ ... })` call could not take.
 */
export async function declareEnvEntries(entries: GurenPluginEnvEntry[]): Promise<{ updated: boolean; unpatched: string[] }> {
  const cwd = process.cwd()
  const content = await readIfExists(cwd, ENV_SCHEMA_FILE)
  if (content === null) return { updated: false, unpatched: [] }

  const declarations = pluginEnvEntries(entries).map((entry) => ({ key: entry.key, source: envEntrySchemaSource(entry) }))
  const patched = insertCallOptions(content, declarations, 'defineEnv')
  if (typeof patched === 'string') return { updated: false, unpatched: declarations.map((declaration) => declaration.key) }
  if (patched.inserted.length === 0) return { updated: false, unpatched: [] }

  await writeFile(resolve(cwd, ENV_SCHEMA_FILE), ensureNamedImports(patched.content, '@guren/core', ['Env']), 'utf8')
  return { updated: true, unpatched: [] }
}

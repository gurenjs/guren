/**
 * Session wiring checks (RFC 0020 §2). Both failures are invisible until
 * runtime: a config no registered provider binds leaves sessions on the
 * in-memory default, which works locally and drops every login on a serverless
 * target; a `database` store whose table the schema does not export throws on
 * the first write. Content-activated — an app with no session config
 * contributes nothing.
 */
import { relative } from 'node:path'
import type { ObjectExpression } from '@babel/types'
import { objectLiteral, propertyValue, type BabelNode } from './ast-walk'
import { resolveSchemaTableBinding } from './schema-binding'
import { check, type CheckResult } from './check-result'
import { appBindsService, readIfExists } from './discovery'
import type { ParseCache, ParsedFile } from './parse-cache'
import { resolveAppEntry } from './provider-registrar'
import type { SchemaTable } from './schema-parser'
import { readSessionConfig, sessionConfigsIn, storeTableIdentifier } from './session-config'

/**
 * Whether a provider that binds `session` is one `createApp()` registers. The
 * binding alone is not enough: a provider file left out of `providers: [...]`
 * never runs, which is the inert-config case this rule exists for. Judged by
 * the entry naming the class, since the array holds identifiers whose import
 * this does not resolve.
 */
async function bindingProviderIsRegistered(cwd: string, providerFiles: string[]): Promise<boolean> {
  const appPath = await resolveAppEntry(cwd)
  const entry = appPath === null ? null : await readIfExists(cwd, appPath)
  if (entry === null) return false

  return providerFiles.some((filePath) => {
    const className = filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.[jt]sx?$/, '')
    return Boolean(className) && new RegExp(`\\b${className}\\b`).test(entry)
  })
}

export async function checkSessionsConfig(options: {
  cwd: string
  cache: ParseCache
  files: string[]
  schemaTables: SchemaTable[]
}): Promise<CheckResult[]> {
  const { cwd, cache, files, schemaTables } = options
  const results: CheckResult[] = []
  let sawConfig = false

  for (const filePath of files) {
    const source = await cache.source(filePath)
    if (!source?.includes('SessionConfig')) continue

    const parsed = await cache.get(filePath)
    if (!parsed) continue

    const configs = sessionConfigsIn(parsed.ast)
    if (configs.length === 0) continue
    sawConfig = true

    const relPath = relative(cwd, filePath)
    for (const { config } of configs) {
      results.push(...checkStoreTables(config, { cwd, filePath, relPath, parsed, schemaTables }))
    }
  }

  if (!sawConfig) return results
  return [...results, await checkBinding(cwd)]
}

function checkStoreTables(
  config: ObjectExpression,
  context: {
    cwd: string
    filePath: string
    relPath: string
    parsed: ParsedFile
    schemaTables: SchemaTable[]
  },
): CheckResult[] {
  const { cwd, filePath, relPath, parsed, schemaTables } = context
  const results: CheckResult[] = []
  const stores = objectLiteral(propertyValue(config, 'stores'))

  for (const entry of (stores?.properties ?? []) as unknown as BabelNode[]) {
    if (entry.type !== 'ObjectProperty') continue
    const store = objectLiteral(entry.value as never)
    if (!store) continue
    // Only the database driver binds a table; every other store's options are
    // its own business.
    if (readSessionConfig(config).stores.get(nameOf(entry) ?? '') !== 'database') continue

    const identifier = storeTableIdentifier(store)
    if (!identifier) continue

    const binding = resolveSchemaTableBinding({
      cwd,
      filePath,
      body: parsed.ast.program.body,
      identifier,
      schemaTables,
    })
    if (!binding) continue

    const key = `sessions-config:${relPath}:${binding.tableName}`
    const title = 'Session store table'
    if (binding.declared) {
      results.push(check(key, title, 'pass', `The database session store binds schema table '${binding.tableName}'.`))
      continue
    }
    results.push(
      check(
        key,
        title,
        'fail',
        `${relPath} binds the database session store to '${binding.tableName}' from ${binding.source}, but no schema `
          + `module declares a table with that export. The store takes the table untyped, so this only fails at `
          + `runtime, on the first request that writes a session.`,
        'Run `bunx guren add session` to add the sessions table, or point the store at the table your schema does export.',
        relPath,
      ),
    )
  }

  return results
}

async function checkBinding(cwd: string): Promise<CheckResult> {
  const key = 'sessions-binding'
  const title = 'Session manager binding'
  const providers = await appBindsService('session', cwd)

  if (providers.length === 0) {
    return check(
      key,
      title,
      'warn',
      "A session config exists, but no provider binds 'session', so the config is never read and sessions stay "
        + 'on the in-memory default — every login lost between requests on Workers, Lambda and Vercel.',
      "Register a provider whose register() calls container.instance('session', createSessionManager(sessionConfig)), "
        + 'and list it in createApp({ providers }). `bunx guren add session` writes one.',
    )
  }

  if (await bindingProviderIsRegistered(cwd, providers)) {
    return check(key, title, 'pass', "A registered provider binds 'session'.")
  }

  return check(
    key,
    title,
    'warn',
    `A provider binds 'session' (${providers.map((file) => relative(cwd, file)).join(', ')}), but createApp() does not `
      + 'register it, so it never runs and sessions stay on the in-memory default.',
    'Add the provider to createApp({ providers: [...] }); `bunx guren add session` wires it for you.',
  )
}

function nameOf(entry: BabelNode): string | undefined {
  const key = entry.key as BabelNode
  if (entry.computed) return undefined
  if (key?.type === 'Identifier') return key.name as string
  if (key?.type === 'StringLiteral') return key.value as string
  return undefined
}

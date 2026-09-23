/**
 * Session wiring checks (RFC 0020 §2). Both failures are invisible until
 * runtime: a config no registered provider binds leaves sessions on the
 * in-memory default, which works locally and drops every login on a serverless
 * target; a `database` store whose table the schema does not export throws on
 * the first write. Content-activated: an app with no session config contributes
 * nothing, and introspects nothing. Judged from the introspected app's `session`
 * section first (RFC 0026 §5), the source reading being the fallback.
 */
import { relative } from 'node:path'
import type { ObjectExpression } from '@babel/types'
import type { SessionEntry } from '@guren/server'
import { objectLiteral, propertyValue, type BabelNode } from './ast-walk'
import { resolveSchemaTableBinding } from './schema-binding'
import { check, type CheckResult } from './check-result'
import { appBindsService, readIfExists } from './discovery'
import type { Introspection } from './introspect'
import { introspectedSection, judgedFromSource, mergeVerdicts } from './manifest-section'
import type { ParseCache, ParsedFile } from './parse-cache'
import { resolveAppEntry } from './provider-registrar'
import type { SchemaTable } from './schema-parser'
import { readSessionConfig, sessionConfigsIn, storeTableIdentifier, type SessionConfigSite } from './session-config'

const TABLE_TITLE = 'Session store table'
const TABLE_FIX = 'Run `bunx guren add session` to add the sessions table, or point the store at the table your schema does export.'
const BINDING_KEY = 'sessions-binding'
const BINDING_TITLE = 'Session manager binding'
const BINDING_FIX = "Register a provider whose register() calls container.instance('session', createSessionManager(sessionConfig)), "
  + 'and list it in createApp({ providers }). `bunx guren add session` writes one.'

/** One session config in the source, with the file it came from. */
interface SessionSite extends SessionConfigSite {
  filePath: string
  relPath: string
  parsed: ParsedFile
}

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

async function readSessionSites(cwd: string, cache: ParseCache, files: string[]): Promise<SessionSite[]> {
  const sites: SessionSite[] = []
  for (const filePath of files) {
    const source = await cache.source(filePath)
    if (!source?.includes('SessionConfig')) continue

    const parsed = await cache.get(filePath)
    if (!parsed) continue

    const relPath = relative(cwd, filePath)
    for (const site of sessionConfigsIn(parsed.ast)) sites.push({ ...site, filePath, relPath, parsed })
  }
  return sites
}

export async function checkSessionsConfig(options: {
  cwd: string
  cache: ParseCache
  files: string[]
  schemaTables: SchemaTable[]
  /** The run's introspection, asked for only once a session config is found (RFC 0026 §5). */
  introspect?: () => Promise<Introspection>
}): Promise<CheckResult[]> {
  const { cwd, cache, files, schemaTables } = options
  const sites = await readSessionSites(cwd, cache, files)
  if (sites.length === 0) return []

  // A definition is bound by the entry's `config` array, which `config-unwired` judges.
  const bindingApplies = sites.some((site) => site.form === 'declared')
  const staticTables = sites.flatMap((site) => checkStoreTables(site, cwd, schemaTables))

  const session = await introspectedSection(options.introspect, 'session')
  if (session.status === 'static') {
    return judgedFromSource([...staticTables, ...(bindingApplies ? [await checkBinding(cwd)] : [])], session.reason)
  }

  // A config the app does not read has no stores in the manifest to judge, so its tables stay on the scan.
  const entry = session.value
  const tables = entry?.source === 'manager'
    ? mergeVerdicts(
        checkManifestStoreTables(entry, sites, cwd, schemaTables).map((result) => ({ ...result, evidence: 'manifest' as const })),
        judgedFromSource(staticTables),
      )
    : judgedFromSource(staticTables)
  return bindingApplies ? [...tables, { ...judgeManifestBinding(entry), evidence: 'manifest' }] : tables
}

/** The store `name` declares in `config`, by its key. */
function storeNamed(config: ObjectExpression, name: string): ObjectExpression | undefined {
  const stores = objectLiteral(propertyValue(config, 'stores'))
  for (const entry of (stores?.properties ?? []) as unknown as BabelNode[]) {
    if (entry.type === 'ObjectProperty' && nameOf(entry) === name) return objectLiteral(entry.value as never) ?? undefined
  }
  return undefined
}

/** The source reading of one config's `database` stores against the schema's exports. */
function checkStoreTables(site: SessionSite, cwd: string, schemaTables: SchemaTable[]): CheckResult[] {
  const { config, filePath, relPath, parsed } = site
  const results: CheckResult[] = []

  // Only the database driver binds a table; every other store's options are its own business.
  for (const [name, driver] of readSessionConfig(config).stores) {
    if (driver !== 'database') continue
    const store = storeNamed(config, name)
    const identifier = store ? storeTableIdentifier(store) : undefined
    if (!identifier) continue

    const binding = resolveSchemaTableBinding({ cwd, filePath, body: parsed.ast.program.body, identifier, schemaTables })
    if (!binding) continue

    const key = `sessions-config:${relPath}:${binding.tableName}`
    if (binding.declared) {
      results.push(check(key, TABLE_TITLE, 'pass', `The database session store binds schema table '${binding.tableName}'.`))
      continue
    }
    results.push(
      check(
        key,
        TABLE_TITLE,
        'fail',
        `${relPath} binds the database session store to '${binding.tableName}' from ${binding.source}, but no schema `
          + `module declares a table with that export. The store takes the table untyped, so this only fails at `
          + `runtime, on the first request that writes a session.`,
        TABLE_FIX,
        relPath,
      ),
    )
  }

  return results
}

/**
 * The `database` stores of the session manager the app binds, by the table object each holds:
 * its SQL name, whichever import or spelling reached it. Keyed like the source reading, on
 * the config that declares the store and the export it names.
 */
function checkManifestStoreTables(entry: SessionEntry, sites: SessionSite[], cwd: string, schemaTables: SchemaTable[]): CheckResult[] {
  const results: CheckResult[] = []
  // A table the static reader could not name is not evidence that the schema lacks one.
  const namesReadable = schemaTables.every((table) => table.tableName !== undefined)

  for (const [name, store] of Object.entries(entry.stores)) {
    if (store.driver !== 'database') continue
    const site = sites.find((candidate) => readSessionConfig(candidate.config).stores.has(name)) ?? sites[0]!
    const storeNode = storeNamed(site.config, name)
    const identifier = storeNode ? storeTableIdentifier(storeNode) : undefined
    const binding = identifier
      ? resolveSchemaTableBinding({ cwd, filePath: site.filePath, body: site.parsed.ast.program.body, identifier, schemaTables })
      : undefined
    const key = `sessions-config:${site.relPath}:${binding?.tableName ?? identifier ?? store.table ?? name}`

    if (store.table === undefined) {
      results.push(
        check(
          key,
          TABLE_TITLE,
          'fail',
          `The '${name}' session store uses the database driver, but its \`table\` is not a Drizzle table in the introspected `
            + `app. The store takes the table untyped, so this only fails at runtime, on the first request that writes a session.`,
          TABLE_FIX,
          site.relPath,
        ),
      )
      continue
    }
    if (schemaTables.some((table) => table.tableName === store.table)) {
      results.push(check(key, TABLE_TITLE, 'pass', `The database session store '${name}' binds schema table '${store.table}'.`))
      continue
    }
    if (!namesReadable) continue
    results.push(
      check(
        key,
        TABLE_TITLE,
        'fail',
        `The '${name}' session store writes to table '${store.table}', but no schema module declares a table by that name, `
          + 'so no migration creates it and the first request that writes a session fails.',
        TABLE_FIX,
        site.relPath,
      ),
    )
  }

  return results
}

/**
 * The inert-config finding from the app itself: a session config nothing reads, because no
 * provider binds `session` in `register()` (RFC 0026 §5).
 */
function judgeManifestBinding(entry: SessionEntry | undefined): CheckResult {
  if (entry?.source === 'manager') {
    return check(BINDING_KEY, BINDING_TITLE, 'pass', `The introspected app binds 'session' to a session manager (default store '${entry.default}').`)
  }
  if (entry?.source === 'auth.sessionOptions.store') {
    return check(
      BINDING_KEY,
      BINDING_TITLE,
      'warn',
      "A session config exists, but no provider binds 'session': createApp({ auth: { sessionOptions: { store } } }) supplies the "
        + 'store, so the config is never read.',
      'Keep one of the two: remove sessionOptions.store and bind the manager from the config, or delete the config.',
    )
  }
  const fallback = entry?.source === 'none' ? ' and sessions stay on the in-memory default' : ''
  return check(
    BINDING_KEY,
    BINDING_TITLE,
    'warn',
    `A session config exists, but the introspected app binds no 'session' in register(), so the config is never read${fallback}. `
      + 'A provider that binds it only in boot() is past the stage introspection runs.',
    BINDING_FIX,
  )
}

async function checkBinding(cwd: string): Promise<CheckResult> {
  const providers = await appBindsService('session', cwd)

  if (providers.length === 0) {
    return check(
      BINDING_KEY,
      BINDING_TITLE,
      'warn',
      "A session config exists, but no provider binds 'session', so the config is never read and sessions stay "
        + 'on the in-memory default — every login lost between requests on Workers, Lambda and Vercel.',
      BINDING_FIX,
    )
  }

  if (await bindingProviderIsRegistered(cwd, providers)) {
    return check(BINDING_KEY, BINDING_TITLE, 'pass', "A registered provider binds 'session'.")
  }

  return check(
    BINDING_KEY,
    BINDING_TITLE,
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

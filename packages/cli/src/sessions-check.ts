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
import type { SessionEntry } from '@guren/server'
import { resolveSchemaTableBinding, schemaDeclaresSqlTable, type SchemaTableBinding } from './schema-binding'
import { check, type CheckResult } from './check-result'
import { appBindsService, readIfExists } from './discovery'
import type { Introspection } from './introspect'
import { introspectedSection, judgedFromManifest, judgedFromSource, mergeVerdicts, type IntrospectedSection } from './manifest-section'
import type { ParseCache, ParsedFile } from './parse-cache'
import { resolveAppEntry } from './provider-registrar'
import type { SchemaTable } from './schema-parser'
import { readSessionConfig, sessionConfigsIn, type SessionConfigSite } from './session-config'

const TABLE_TITLE = 'Session store table'
const TABLE_FIX = 'Run `bunx guren add session` to add the sessions table, or point the store at the table your schema does export.'
const BINDING_KEY = 'sessions-binding'
const BINDING_TITLE = 'Session manager binding'
const BINDING_FIX = "Register a provider whose register() calls container.instance('session', createSessionManager(sessionConfig)), "
  + 'and list it in createApp({ providers }). `bunx guren add session` writes one.'

export interface SessionSite extends SessionConfigSite {
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

/** The session configs in source and, once one is found, the introspected `session` section. */
export interface SessionWiring {
  sites: SessionSite[]
  session: Promise<IntrospectedSection<SessionEntry | undefined>>
}

/**
 * Reads the session configs and starts the introspection when there is one, so `guren check`
 * can call it before its suites and have the child overlap them (RFC 0026 §5).
 */
export async function readSessionWiring(
  cwd: string,
  cache: ParseCache,
  files: string[],
  introspect?: () => Promise<Introspection>,
): Promise<SessionWiring> {
  const sites = await readSessionSites(cwd, cache, files)
  const session = sites.length > 0 ? introspectedSection(introspect, 'session') : Promise.resolve({ status: 'static' as const })
  return { sites, session }
}

export async function checkSessionsConfig(options: {
  cwd: string
  cache: ParseCache
  files: string[]
  schemaTables: SchemaTable[]
  /** The run's introspection, asked for only once a session config is found. */
  introspect?: () => Promise<Introspection>
  /** {@link readSessionWiring}'s result when the caller started it early; read here otherwise. */
  wiring?: Promise<SessionWiring>
}): Promise<CheckResult[]> {
  const { cwd, cache, files, schemaTables } = options
  const { sites, session: sessionRead } = await (options.wiring ?? readSessionWiring(cwd, cache, files, options.introspect))
  if (sites.length === 0) return []

  // A definition is bound by the entry's `config` array, which `config-unwired` judges.
  const bindingApplies = sites.some((site) => site.form === 'declared')
  const staticTables = sites.flatMap((site) => checkStoreTables(site, cwd, schemaTables))

  const session = await sessionRead
  if (session.status === 'static') {
    return judgedFromSource([...staticTables, ...(bindingApplies ? [await checkBinding(cwd)] : [])], session.reason)
  }

  // A config the app does not read has no stores in the manifest to judge, so its tables stay on the scan.
  const entry = session.value
  const tables = entry?.source === 'manager'
    ? mergeVerdicts(judgedFromManifest(checkManifestStoreTables(entry, sites, cwd, schemaTables)), judgedFromSource(staticTables))
    : judgedFromSource(staticTables, 'the introspected app binds no session manager, so it never reads this config')
  return bindingApplies ? [...tables, ...judgedFromManifest([judgeManifestBinding(entry)])] : tables
}

/** What store `name` of a config binds, by the identifier its `table` names. */
function storeBinding(site: SessionSite, name: string, cwd: string, schemaTables: SchemaTable[]): { identifier?: string; binding?: SchemaTableBinding } {
  const identifier = readSessionConfig(site.config).tables.get(name)
  if (!identifier) return {}
  const binding = resolveSchemaTableBinding({ cwd, filePath: site.filePath, body: site.parsed.ast.program.body, identifier, schemaTables })
  return { identifier, ...(binding ? { binding } : {}) }
}

/** The source reading of one config's `database` stores against the schema's exports. */
function checkStoreTables(site: SessionSite, cwd: string, schemaTables: SchemaTable[]): CheckResult[] {
  const { config, relPath } = site
  const results: CheckResult[] = []

  // Only the database driver binds a table; every other store's options are its own business.
  for (const [name, driver] of readSessionConfig(config).stores) {
    if (driver !== 'database') continue
    const { binding } = storeBinding(site, name, cwd, schemaTables)
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

  for (const [name, store] of Object.entries(entry.stores)) {
    if (store.driver !== 'database') continue
    // The manifest does not say which config built the manager: among the configs declaring the store,
    // the one whose export the schema names as this table, else the first.
    const candidates = sites
      .filter((candidate) => readSessionConfig(candidate.config).stores.has(name))
      .map((candidate) => ({ site: candidate, ...storeBinding(candidate, name, cwd, schemaTables) }))
    const { site, identifier, binding } = candidates.find((candidate) => candidate.binding?.sqlName === store.table)
      ?? candidates[0]
      ?? { site: sites[0]!, identifier: undefined, binding: undefined }
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
    const declared = schemaDeclaresSqlTable(schemaTables, store.table)
    if (declared) {
      results.push(check(key, TABLE_TITLE, 'pass', `The database session store '${name}' binds schema table '${store.table}'.`))
      continue
    }
    // Unreadable schema names: the source verdict for this key, if any, stands.
    if (declared === undefined) continue
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

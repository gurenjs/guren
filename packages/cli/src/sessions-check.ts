/**
 * Session wiring checks (RFC 0020 §2). Both failures are invisible until
 * runtime: a config no registered provider binds leaves sessions on the
 * in-memory default, which works locally and drops every login on a serverless
 * target; a `database` store whose table the schema does not export throws on
 * the first write. Content-activated: an app with no session config contributes
 * nothing, and introspects nothing. The binding is the introspected app's `session`
 * section (RFC 0026 §5), `-unverified` without it; a store's table is also read from
 * source, since a missing export is a link error that fails the introspection.
 */
import { relative } from 'node:path'
import type { SessionEntry } from '@guren/server'
import { attributeManifestTable, resolveSchemaTableBinding, type SchemaTableBinding } from './schema-binding'
import { advisory, check, type CheckResult } from './check-result'
import { introspectedSection, judgedFromManifest, judgedFromSource, mergeVerdicts, UNVERIFIED_SECTION_FIX, type IntrospectedSection, type IntrospectSource } from './manifest-section'
import type { ParseCache, ParsedFile } from './parse-cache'
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
  introspect?: IntrospectSource,
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
  introspect?: IntrospectSource
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
    return [...judgedFromSource(staticTables, session.reason), ...(bindingApplies ? [bindingUnverified(session.reason)] : [])]
  }

  // A config the app does not read has no stores in the manifest to judge, so its tables stay on the scan.
  const entry = session.value
  const tables = entry?.source === 'manager'
    ? mergeVerdicts(judgedFromManifest(checkManifestStoreTables(entry, sites, cwd, schemaTables)), judgedFromSource(staticTables))
    : judgedFromSource(staticTables, 'the introspected app binds no session manager, so it never reads this config')
  // The app refuses to boot with both, whichever form the config takes, so this is reported for either.
  if (session.manifest.warnings.some((warning) => warning.code === 'session-configured-twice')) {
    return [...tables, ...judgedFromManifest([configuredTwice()])]
  }
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

/** The `database` stores of the session manager the app binds, by the table object each holds, attributed by {@link attributeManifestTable}. */
function checkManifestStoreTables(entry: SessionEntry, sites: SessionSite[], cwd: string, schemaTables: SchemaTable[]): CheckResult[] {
  const results: CheckResult[] = []

  for (const [name, store] of Object.entries(entry.stores)) {
    if (store.driver !== 'database') continue
    const candidates = sites
      .filter((candidate) => readSessionConfig(candidate.config).stores.has(name))
      .map((candidate) => ({ site: candidate, ...storeBinding(candidate, name, cwd, schemaTables) }))
    const attributed = attributeManifestTable(store.table, candidates, schemaTables)
    if (!attributed) continue
    // No config the source reads declares the store (a spread, a computed key): keyed on the store alone.
    const targets = attributed.at.length > 0 ? attributed.at : [undefined]
    for (const target of targets) {
      const key = target
        ? `sessions-config:${target.site.relPath}:${target.binding?.tableName ?? target.identifier ?? store.table ?? name}`
        : `sessions-config:${name}`
      results.push(storeTableVerdict(attributed.outcome, key, name, store.table, target?.site.relPath))
    }
  }

  return results
}

function storeTableVerdict(
  outcome: 'untyped' | 'declared' | 'unfound',
  key: string,
  name: string,
  table: string | undefined,
  relPath: string | undefined,
): CheckResult {
  switch (outcome) {
    case 'declared':
      return check(key, TABLE_TITLE, 'pass', `The database session store '${name}' binds schema table '${table}'.`)
    case 'untyped':
      return check(
        key,
        TABLE_TITLE,
        'fail',
        `The '${name}' session store uses the database driver, but its \`table\` is not a Drizzle table in the introspected `
          + `app. The store takes the table untyped, so this only fails at runtime, on the first request that writes a session.`,
        TABLE_FIX,
        relPath,
      )
    case 'unfound':
      return advisory(
        key,
        TABLE_TITLE,
        'warn',
        `The '${name}' session store writes to table '${table}', which the schema reader did not find in any app root's `
          + 'db/schema.ts. If no schema file drizzle-kit reads declares it, no migration creates it and the first request '
          + 'that writes a session fails.',
        'Declare the table in db/schema.ts (`bunx guren add session` adds one), or ignore this if your drizzle.config reads it from another file.',
        relPath,
      )
  }
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
        + 'store, so the config is read only where that store is built from it.',
      'Bind the manager from the config and drop sessionOptions.store, or delete the config if nothing builds a store from it.',
    )
  }
  const fallback = entry?.source === 'none' ? ' and sessions stay on the in-memory default' : ''
  return check(
    BINDING_KEY,
    BINDING_TITLE,
    'warn',
    `A session config exists, but the introspected app binds no 'session' in register(), so the config is never read${fallback}. `
      + 'Binding it in boot() is too late: the session middleware is built before any app provider boots.',
    BINDING_FIX,
  )
}

/** A bound session manager beside `auth.sessionOptions.store`, which `AuthServiceProvider` refuses at boot. */
function configuredTwice(): CheckResult {
  return check(
    BINDING_KEY,
    BINDING_TITLE,
    'fail',
    "The introspected app binds a 'session' manager and also passes createApp({ auth: { sessionOptions: { store } } }). "
      + 'The app refuses to boot with both.',
    'Keep one: remove sessionOptions.store and let the manager supply the store, or stop binding the manager.',
  )
}

/**
 * Whether a provider binds the config is a fact of the registered app: the source can name a
 * provider that binds `session`, not that `createApp()` runs it.
 */
function bindingUnverified(reason: string | undefined): CheckResult {
  const why = reason ?? 'no introspected app was available'
  return {
    ...advisory(
      `${BINDING_KEY}-unverified`,
      BINDING_TITLE,
      'warn',
      `A session config exists, and whether a registered provider binds 'session' to it is unverified: ${why}. `
        + 'An unbound config is never read, and sessions stay on the in-memory default.',
      `${UNVERIFIED_SECTION_FIX} ${BINDING_FIX}`,
    ),
    evidence: 'none',
  }
}

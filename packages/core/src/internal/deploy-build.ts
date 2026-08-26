/**
 * Build-time helpers shared by the deploy plugins (`@guren/plugin-cloudflare`,
 * `@guren/plugin-lambda`, `@guren/plugin-vercel`).
 *
 * Internal by the rules in `contributing/api-stability.md`: reachable only
 * through a deep import under `internal/`, never re-exported from
 * `@guren/core`'s index. No stability guarantee — it exists so the three
 * plugins stop carrying three copies of the same knowledge, not as a public
 * extension point.
 *
 * Deliberately imports nothing from the framework itself: a plugin's build
 * step should not drag the runtime into a developer's build process. Only
 * `node:` builtins belong here, and `deploy-build.test.ts` asserts it of the
 * built artifact — the property would otherwise break silently the day the bundler
 * splits a shared chunk out of this entry.
 *
 * What does *not* belong here: anything a platform legitimately decides for
 * itself. The message naming a platform and its replacement API, where a
 * rendered stub is delivered (Workers resolves an alias to a file on disk,
 * Lambda hands source to its bundler plugin), whether a missing `build` script
 * is fatal, and how an SSR bundle's renderer export is verified are all
 * per-plugin by design.
 *
 * One rule holds across the helpers here: a helper that *relates* two paths —
 * a containment test, a relative specifier — canonicalizes both first, because
 * whatever consumes the answer resolves links too. A helper that merely reads
 * or writes one path passes it through, since the OS follows the links itself.
 * That is why `resolveSsrEntryFile` compares raw strings (both operands derive
 * from one `ssrDir`, so no link can come between them) and why the plugins'
 * own `relative(root, out)` for `wrangler.jsonc` must stay lexical: that path
 * is read by wrangler, not by a bundler resolving a module from its real path.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export type PathLike = string | URL

export type ManifestEntry = {
  file?: string
  css?: string[]
}

export type Manifest = Record<string, ManifestEntry>

export function resolvePathLike(value: PathLike): string {
  return value instanceof URL ? fileURLToPath(value) : resolve(String(value))
}

/**
 * Read the first manifest that parses, tolerating both Vite layouts
 * (`.vite/manifest.json` and the flat `manifest.json` older configs emit), and
 * report which path it was. A malformed file is skipped rather than fatal —
 * the caller decides what a missing manifest means for its platform. The path
 * is part of the result because a caller publishing the manifest location to
 * the runtime has to name the file that was actually parsed: testing which one
 * *exists* picks the malformed one that was just skipped.
 */
export function readManifest(
  ...paths: string[]
): { manifest: Manifest; path: string } | undefined {
  for (const path of paths) {
    if (!existsSync(path)) {
      continue
    }

    try {
      return { manifest: JSON.parse(readFileSync(path, 'utf8')) as Manifest, path }
    } catch {
      continue
    }
  }

  return undefined
}

/** The two layouts `readManifest` accepts, in preference order. */
function manifestPaths(dir: string): [string, string] {
  return [resolve(dir, '.vite/manifest.json'), resolve(dir, 'manifest.json')]
}

/**
 * Resolve symlinks in the parts of `path` that exist, keeping the trailing
 * components that do not. `realpathSync` throws on a path that is not there
 * yet, and an output directory usually is not on a first build.
 *
 * A sibling of `realpathNearestExisting` in `@guren/cli`'s plugin-manifest.ts,
 * kept as a copy because this module must not import beyond node builtins and
 * cli cannot be imported from core. Only ENOENT walks up, matching the twin:
 * any other failure (an unreadable or non-directory ancestor) is surfaced
 * rather than silently treated as nonexistent — both callers relate two paths
 * (a deletion guard, an import specifier) and neither may answer from a path
 * it could not actually resolve.
 */
function realpathOfNearestExisting(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const parent = dirname(path)
  if (parent === path) {
    return path
  }

  return resolve(realpathOfNearestExisting(parent), basename(path))
}

/**
 * Throw unless `out` is safe to delete: it must be neither the app root nor a
 * directory containing it.
 *
 * Relates two paths, so it canonicalizes both: comparing lexically would
 * accept `outputDir` values that reach the app root the long way, and the
 * delete that follows resolves the links regardless.
 *
 * Containment is then decided with `relative` rather than a string prefix
 * because `out + sep` is `//` at the filesystem root, which no absolute path
 * is prefixed by — a prefix test lets `outputDir: '/'` through. The escape
 * test is `'..'` exactly or a `'../'` prefix, not `startsWith('..')`: a
 * directory legitimately named `..-source` inside `out` yields the relative
 * path `..-source`, which the looser test would read as an escape.
 *
 * Exported separately from `resetOutputDir` so a caller can validate the
 * option early and delete later, but the delete itself should always go
 * through `resetOutputDir`.
 *
 * @param label Platform name for the error message, e.g. `'Lambda build'`.
 */
export function assertOutputDirOutsideRoot(out: string, root: string, label: string): void {
  const outToRoot = relative(realpathOfNearestExisting(out), realpathOfNearestExisting(root))
  const rootIsInsideOut =
    outToRoot !== '..' && !outToRoot.startsWith(`..${sep}`) && !isAbsolute(outToRoot)

  if (outToRoot === '' || rootIsInsideOut) {
    throw new Error(
      `${label}: outputDir (${out}) must be a directory outside or below the app root, never the root itself or a parent of it — it is deleted on every build.`,
    )
  }
}

/**
 * Delete the output directory so the build starts from a clean slate, after
 * checking it is safe to delete.
 *
 * The check and the delete are one call on purpose: they were separate
 * statements in each plugin, and a plugin that had only the delete has already
 * shipped.
 *
 * @param label Platform name for the error message, e.g. `'Lambda build'`.
 */
export function resetOutputDir(out: string, root: string, label: string): void {
  assertOutputDirOutsideRoot(out, root, label)

  if (existsSync(out)) {
    rmSync(out, { recursive: true, force: true })
  }
}

/**
 * Relative specifier for importing `target` from a module written into
 * `fromDir`, in POSIX form so the emitted source is platform-agnostic.
 *
 * Relates two paths, so it canonicalizes both: the bundler resolves the
 * emitted module from its real path, and a link that changes depth would
 * otherwise leave the specifier short a `..` segment.
 *
 * @param label Platform name for the error message, e.g. `'Lambda build'`.
 */
export function importSpecifier(fromDir: string, target: string, label: string): string {
  const rel = relative(realpathOfNearestExisting(fromDir), realpathOfNearestExisting(target))
  if (isAbsolute(rel)) {
    throw new Error(
      `${label}: ${target} cannot be imported relative to ${fromDir} (different drive or root?). Keep the app, SSR output, and outputDir on the same volume.`,
    )
  }

  const specifier = rel.split(sep).join('/')
  return specifier.startsWith('.') ? specifier : `./${specifier}`
}

export interface ClientAssetEnv {
  entry?: string
  styles?: string
}

/**
 * Locate the built client entry and its CSS in the Vite client manifest, as
 * the `/assets/`-prefixed URLs the Inertia head expects.
 *
 * Takes the public directory rather than the app root so a caller passing a
 * custom `publicDir` is honoured.
 *
 * @param label Platform name for the warning message, e.g. `'Lambda build'`.
 */
export function resolveClientAssetEnv(
  publicDir: string,
  clientEntryKey: string,
  label: string,
): ClientAssetEnv {
  const manifest = readManifest(...manifestPaths(resolve(publicDir, 'assets')))?.manifest

  const entry = manifest?.[clientEntryKey]
  if (!entry?.file) {
    console.warn(
      `${label}: no client manifest entry for "${clientEntryKey}"; GUREN_INERTIA_ENTRY will not be set.`,
    )
    return {}
  }

  return {
    entry: `/assets/${entry.file}`,
    styles: entry.css?.length ? entry.css.map((file) => `/assets/${file}`).join(',') : undefined,
  }
}

/**
 * The client build manifest as JSON text, for the deploy targets' runtime
 * manifest injection (`GUREN_VITE_MANIFEST`): `viteAsset()` resolves
 * content-page asset URLs from the client manifest at render time, and a
 * bundled function or worker has no `public/assets/manifest.json` to read.
 * How the payload reaches the runtime is per-plugin (a generated-entry
 * assignment, a bundler `define`); *what* the payload is, is this.
 *
 * Separate from `resolveClientAssetEnv` because that helper answers only for
 * the client *entry*: a content-page app can have a manifest of CSS build
 * inputs and no `resources/js/app.tsx` at all, and its `viteAsset()` calls
 * still need the whole manifest.
 *
 * Re-serialized from the parsed object rather than passed through as raw
 * text, so the payload is exactly what `readManifest` accepted — a file that
 * failed to parse here is never shipped to fail again at first render.
 */
export function clientManifestJson(publicDir: string): string | undefined {
  const read = readManifest(...manifestPaths(resolve(publicDir, 'assets')))
  return read ? JSON.stringify(read.manifest) : undefined
}

/**
 * Absolute path of the built SSR entry chunk, or undefined when the app has no
 * SSR build. Verifying that the chunk actually exports a renderer is left to
 * the caller: the platforms disagree on whether importing it during a build is
 * acceptable.
 *
 * @param label Platform name for the error messages, e.g. `'Lambda build'`.
 */
export function resolveSsrEntryFile(
  ssrDir: string,
  ssrEntryKey: string,
  label: string,
): string | undefined {
  const manifest = readManifest(...manifestPaths(ssrDir))?.manifest

  const entryFile = manifest?.[ssrEntryKey]?.file
  if (!entryFile) {
    return undefined
  }

  const file = resolve(ssrDir, entryFile)
  if (!file.startsWith(ssrDir + sep)) {
    throw new Error(`${label}: SSR manifest entry "${entryFile}" escapes the SSR output directory ${ssrDir}.`)
  }
  if (!existsSync(file)) {
    throw new Error(`${label}: SSR manifest points at ${file}, but the file does not exist.`)
  }

  return file
}

/**
 * Runtime locations of a staged SSR bundle, for platforms that copy `ssrDir`
 * under the function root and hand the layout to the server through
 * environment variables. `prefix` is where the caller stages the directory —
 * it cannot be derived here because staging happens later in the caller's own
 * flow.
 *
 * The manifest path is derived from the file that parsed rather than the
 * first one that exists: both Vite layouts occur in the wild, and a malformed
 * `.vite/manifest.json` alongside a valid flat one would otherwise publish the
 * path to the file that was skipped. It is optional only for the mid-build
 * race where the manifest vanishes between `resolveSsrEntryFile` and this
 * call — callers already hold a chunk path that manifest produced.
 */
export function ssrRuntimePaths(
  ssrDir: string,
  ssrFile: string,
  prefix: string,
): { entry: string; manifest?: string } {
  const under = (target: string) => `${prefix}/${relative(ssrDir, target).split(sep).join('/')}`
  const read = readManifest(...manifestPaths(ssrDir))

  return {
    entry: under(ssrFile),
    manifest: read ? under(read.path) : undefined,
  }
}

/**
 * Copy `public/` into a platform's static-asset staging directory.
 *
 * Two pieces of Guren-specific knowledge, not platform policy, which is why
 * this is shared: the dev-mode `index.html` shell must never ship (it would
 * shadow the app's root route on any host that serves static files first), and
 * built assets self-reference the Vite plugin's derived base `/public/assets/`
 * while HTML references use `/assets/` — so on a host without rewrites the
 * built-assets directory has to appear under both prefixes.
 */
export function stageStaticAssets(publicDir: string, assetsOut: string): void {
  mkdirSync(assetsOut, { recursive: true })

  if (!existsSync(publicDir)) {
    return
  }

  cpSync(publicDir, assetsOut, { recursive: true })

  const shadowingIndex = resolve(assetsOut, 'index.html')
  if (existsSync(shadowingIndex)) {
    rmSync(shadowingIndex)
  }

  const clientAssetsDir = resolve(publicDir, 'assets')
  if (existsSync(clientAssetsDir)) {
    cpSync(clientAssetsDir, resolve(assetsOut, 'public/assets'), { recursive: true })
  }
}

/** What a dev-only module is needed for, so a plugin can word its own message. */
export type DevOnlyModuleKind = 'sqlite' | 'vite' | 'mcp' | 'sql-driver'

export interface DevOnlyModule {
  readonly specifier: string
  readonly kind: DevOnlyModuleKind
  /**
   * Names the importing code destructures. A stub must declare every one of
   * them: an empty module fails the bundle with "no matching export" rather
   * than at runtime. Empty means the module is only ever read through
   * namespace property access, so an empty module suffices.
   */
  readonly exportNames: readonly string[]
}

/**
 * Modules that cannot run off Bun but sit in the graph of any app importing
 * `@guren/core`, reached only through dev-time branches. Core aggregates
 * `@guren/server` and `@guren/orm`, where these imports actually live, so it
 * is the one package that sees the whole set — which is why the list lives
 * here rather than in each plugin, where two copies had already drifted apart.
 *
 * Bundlers follow these imports even when they are dynamic, so without stubs
 * the build either fails to resolve them or ships megabytes of dev tooling.
 *
 * - `sqlite` — the local sqlite ORM factory, opposite the platform's own
 *   database branch in `config/database.ts`.
 * - `vite` — the dev asset server `Application` starts when serving locally.
 * - `mcp` — the opt-in MCP endpoint's lazy imports, which drag the CLI
 *   generators (and Babel) plus the MCP SDK in behind them.
 *
 * SQL client libraries are deliberately *not* here: they are dev-only on
 * Workers, where D1 is the only database, and load-bearing on Lambda and
 * Vercel, which connect to Postgres. See `SQL_CLIENT_MODULES`.
 *
 * `as const` so a consumer can key an exhaustive table on the specifiers and
 * have a new entry here surface as a compile error there.
 */
export const DEV_ONLY_MODULES = [
  { specifier: 'bun:sqlite', kind: 'sqlite', exportNames: ['Database'] },
  { specifier: 'vite', kind: 'vite', exportNames: ['createServer'] },
  { specifier: '@guren/cli', kind: 'mcp', exportNames: [] },
  {
    specifier: '@modelcontextprotocol/sdk/server/mcp.js',
    kind: 'mcp',
    exportNames: ['McpServer', 'ResourceTemplate'],
  },
  {
    specifier: '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js',
    kind: 'mcp',
    exportNames: ['WebStandardStreamableHTTPServerTransport'],
  },
] as const satisfies readonly DevOnlyModule[]

/**
 * A database `@guren/orm` can connect through, named after the factory an
 * app's database config calls to declare it.
 */
export type DatabaseDialect = 'postgres' | 'mysql' | 'sqlite' | 'aws-data-api' | 'd1'

/**
 * The `@guren/orm` factory names an app's database config calls, and the
 * dialect each one declares.
 *
 * Taken from `@guren/core`'s export allowlist rather than from the ORM's
 * implementation files, and pinned there by a test: a list built from the
 * implementation admits names that were never exported and misses the aliases
 * that were. The spelling is `createMySqlDatabase`, not `createMysqlDatabase`
 * — a build that filters on a name nobody exports detects nothing and stubs
 * nothing, which is silent.
 */
export const DATABASE_FACTORIES = {
  createPostgresDatabase: 'postgres',
  createMySqlDatabase: 'mysql',
  createSqliteDatabase: 'sqlite',
  createAwsDataApiDatabase: 'aws-data-api',
  createD1Database: 'd1',
} as const satisfies Record<string, DatabaseDialect>

/** A client library reached only by the dialect it belongs to. */
export interface SqlClientModule extends DevOnlyModule {
  readonly dialect: DatabaseDialect
}

/**
 * The database client libraries `@guren/orm`'s Postgres, MySQL and Aurora
 * Data API factories reach for.
 *
 * They sit apart from `DEV_ONLY_MODULES` because whether they are dead weight
 * depends on the platform: on Workers, D1 is the only database there is, so
 * every one of these is unreachable; on Lambda and Vercel the app connects to
 * Postgres through them and stubbing them would break a working deploy.
 *
 * That makes the list itself the wrong granularity for a platform that hosts
 * more than one dialect. Workers stubs all of it; Lambda and Vercel stub the
 * entries whose `dialect` the app's config does not declare, which is what
 * `unusedSqlClients` decides.
 *
 * A platform where they are unreachable has to stub them rather than ignore
 * them. `@guren/orm` names them in *literal* dynamic imports, which a bundler
 * follows whether or not the branch can be taken — so a D1 app failed to
 * bundle on `Could not resolve "postgres"`, naming a database its author had
 * deliberately not chosen. Both the client and the drizzle entry point that
 * imports it need stubbing: aliasing only the client leaves drizzle's own
 * `import pgClient from "postgres"` to resolve.
 *
 * Export names are read off drizzle-orm's driver and session modules, which
 * is what a bundler checks a stub against.
 */
export const SQL_CLIENT_MODULES = [
  { specifier: 'postgres', kind: 'sql-driver', dialect: 'postgres', exportNames: [] },
  { specifier: 'mysql2', kind: 'sql-driver', dialect: 'mysql', exportNames: [] },
  { specifier: 'mysql2/promise', kind: 'sql-driver', dialect: 'mysql', exportNames: ['createPool'] },
  {
    specifier: '@aws-sdk/client-rds-data',
    kind: 'sql-driver',
    dialect: 'aws-data-api',
    exportNames: [
      'RDSDataClient',
      'BeginTransactionCommand',
      'CommitTransactionCommand',
      'ExecuteStatementCommand',
      'RollbackTransactionCommand',
    ],
  },
] as const satisfies readonly SqlClientModule[]

export type SqlClientSpecifier = (typeof SQL_CLIENT_MODULES)[number]['specifier']

/**
 * Where an app declares its database, in the order it is looked for.
 *
 * The same pair `guren doctor` checks, kept as a copy for the same reason
 * `realpathOfNearestExisting` above is one: this module must not import
 * beyond node builtins, and cli cannot be imported from core. If the two ever
 * disagree, a build would stub clients for an app whose config the doctor
 * says is fine — so a change to either belongs in both.
 */
export const DATABASE_CONFIG_CANDIDATES = ['config/database.ts', 'db/config.ts'] as const

export interface DatabaseDialectDetection {
  /**
   * Every dialect the config declares, or undefined when the build could not
   * tell — which is not the same as "none", and callers must not treat it as
   * an empty set.
   */
  dialects?: readonly DatabaseDialect[]
  /** Root-relative path of the file that was read, when one was found. */
  source?: string
}

/**
 * Which databases an app connects to, read off its database config.
 *
 * A *union*, never a single answer: an app legitimately names two factories in
 * one file, picking between them at runtime — the Workers app in this
 * repository declares D1 for the deployed worker and sqlite for local
 * development, and a Lambda app can pair Postgres with sqlite the same way.
 * Taking the first match would stub a client the app really does reach for.
 *
 * Matching is a scan for the factory names, not a parse: every way of being
 * wrong about a name that *is* in the file — mentioned in a comment, imported
 * but never called, called in a branch this deploy will not take — errs
 * toward reporting a dialect the app might not use, and the caller stubs
 * fewer clients as a result. The opposite error is the dangerous one, so the
 * cheap reading is the right one. A config that reaches a factory without
 * naming it (a re-export, an indirection through another module) reports
 * nothing, and the caller stubs nothing.
 */
export function detectDatabaseDialects(root: string): DatabaseDialectDetection {
  for (const candidate of DATABASE_CONFIG_CANDIDATES) {
    const path = resolve(root, candidate)
    if (!existsSync(path)) {
      continue
    }

    let source: string
    try {
      source = readFileSync(path, 'utf8')
    } catch {
      return { source: candidate }
    }

    const dialects = new Set<DatabaseDialect>()
    for (const [factory, dialect] of Object.entries(DATABASE_FACTORIES)) {
      if (new RegExp(`\\b${factory}\\b`).test(source)) {
        dialects.add(dialect)
      }
    }

    return dialects.size > 0 ? { dialects: [...dialects], source: candidate } : { source: candidate }
  }

  return {}
}

/** Every dialect name `databaseDialects` accepts, for validation and messages. */
export const DATABASE_DIALECTS = [...new Set(Object.values(DATABASE_FACTORIES))] as readonly DatabaseDialect[]

/**
 * Reject a dialect list that names nothing, or names something that is not a
 * dialect.
 *
 * Both are rejected rather than dropped because both mean the same thing to
 * the filter downstream — a dialect it never sees is a dialect whose client it
 * stubs. An empty list stubs *every* client, and `['postgress']` stubs the
 * Postgres one; either way the bundle builds clean and the deployed function
 * cannot reach its own database. That is the failure the caller reached for
 * this option to avoid, so it fails here, at build time, with the typo in the
 * message.
 *
 * Deliberately not a fail-open: the surrounding code stubs nothing when it
 * cannot *read* an app's dialects, but this input is a caller stating them.
 * Falling back to detection would discard the override and then stub according
 * to the very config the caller was overriding.
 *
 * @param label Platform name for the error message, e.g. `'Lambda build'`.
 */
function assertDatabaseDialects(
  names: readonly string[],
  label: string,
  quoted: string,
): readonly DatabaseDialect[] {
  const unknown = names.filter((name) => !DATABASE_DIALECTS.includes(name as DatabaseDialect))
  if (names.length === 0 || unknown.length > 0) {
    throw new Error(
      `${label}: ${quoted} does not name a database. Expected one or more of ${DATABASE_DIALECTS.join(', ')}.`,
    )
  }

  return names as readonly DatabaseDialect[]
}

/**
 * Parse a comma-separated `--database` value into dialects.
 *
 * @param label Platform name for the error message, e.g. `'Lambda build'`.
 */
export function parseDatabaseDialects(value: string, label: string): readonly DatabaseDialect[] {
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)

  return assertDatabaseDialects(names, label, JSON.stringify(value))
}

/** One client to stub, with the explanation its stub throws. */
export interface UnusedSqlClient {
  readonly module: SqlClientModule
  readonly message: string
}

/**
 * The database clients an app does not connect through, for a platform where
 * the ones it *does* connect through are load-bearing — Lambda and Vercel,
 * as opposed to Workers, where D1 is the only database and every client in
 * `SQL_CLIENT_MODULES` is unreachable regardless of what the config says.
 *
 * Fails open: when the dialects cannot be read, this warns and returns
 * nothing to stub. The two errors are not symmetric. Under-stubbing leaves
 * today's behaviour — the build fails to resolve a client the app never
 * installed, loudly, at build time. Over-stubbing produces a bundle that
 * builds clean and then cannot reach its own database, at runtime, in
 * production. Only the second is worth protecting against, so anything less
 * than positive evidence means stub nothing.
 *
 * @param dialects Overrides detection when the caller already knows, for an
 *   app whose config the scan cannot read.
 * @param label Platform name for the messages, e.g. `'Lambda build'`.
 */
export function unusedSqlClients(input: {
  root: string
  label: string
  dialects?: readonly DatabaseDialect[]
}): readonly UnusedSqlClient[] {
  const { root, label } = input
  // An empty array is truthy, so this cannot be a plain `input.dialects ?`
  // test: that reads a caller's empty list as "this app declares nothing",
  // which stubs every client including the one it connects through.
  const detection = input.dialects
    ? { dialects: assertDatabaseDialects(input.dialects, label, `databaseDialects ${JSON.stringify(input.dialects)}`) }
    : detectDatabaseDialects(root)
  const declared = detection.dialects

  if (!declared) {
    console.warn(
      `${label}: ${detection.source ? `${detection.source} names no @guren/orm database factory` : `no database config found (looked for ${DATABASE_CONFIG_CANDIDATES.join(', ')})`}`
        + ` — every database client stays in the module graph, and the build fails on any this app has not installed.`
        + ` Name them with the build's "databaseDialects" option (--database on the command line).`,
    )
    return []
  }

  const declaredList = declared.join(', ')
  return SQL_CLIENT_MODULES.filter((module) => !declared.includes(module.dialect)).map((module) => ({
    module,
    message:
      `${label}: the "${module.specifier}" client is stubbed — this app declares ${declaredList}, not ${module.dialect}.`
      + ` @guren/orm names every dialect's client in a dynamic import that bundlers follow even when the branch cannot be taken,`
      + ` so an uninstalled client would otherwise fail the build.`
      + ` If this app really does connect with ${module.dialect}, pass databaseDialects: ['${module.dialect}'] to the build.`,
  }))
}

export type DevOnlySpecifier = (typeof DEV_ONLY_MODULES)[number]['specifier']

/**
 * Source for a stub replacing one dev-only module. Shared because what it
 * encodes is a bundler constraint, not a platform choice: every name the
 * importer destructures must be present or the bundle fails with "no matching
 * export", and each is emitted as a throwing *function* because the stubbed
 * names mix constructors (`new Database()`) with plain calls
 * (`createServer()`) — a class invoked without `new` reports "Class
 * constructor cannot be invoked without 'new'" instead of the real reason.
 *
 * @param message Platform-specific explanation, including the replacement API.
 */
/**
 * A JavaScript string literal for `value`.
 *
 * `JSON.stringify` alone is not one: JSON and JavaScript disagree about
 * U+2028 and U+2029, which JSON leaves raw while JavaScript reads them as
 * line terminators — so a message containing either ends the statement it was
 * embedded in on any target below ES2019.
 */
function toJsStringLiteral(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

export function renderDevOnlyStub(module: DevOnlyModule, message: string): string {
  // The message reaches the file twice and needs different escaping each
  // time: as a string literal in the thrown error, and as text in a comment
  // that any line terminator would end, running whatever followed as code.
  // Callers pass literals today; the escaping is here because this is where
  // the file is constructed, not where the strings happen to come from.
  const comment = message.replace(/[\r\n\u2028\u2029]+/g, ' ')
  const error = `throw new Error(${toJsStringLiteral(message)})`
  const throwing = module.exportNames
    .map((name) => `export function ${name}() { ${error} }`)
    .join('\n')

  // The default export is a *function*, not an object of the named ones:
  // `drizzle-orm/postgres-js` does `import pgClient from "postgres"` and calls
  // it, and a module with no default at all fails the bundle outright with
  // "no matching export". Attaching the named exports keeps the previous
  // object-shaped access working.
  const named = module.exportNames.length > 0 ? `, { ${module.exportNames.join(', ')} }` : ''
  const fallback = `function unavailable() { ${error} }`
  return `// ${comment}\n${throwing}\n${fallback}\nexport default Object.assign(unavailable${named})\n`
}

/**
 * The MCP SDK is only ever reached through subpaths, and a bundler alias on a
 * package name does not cover them — which is why `DEV_ONLY_MODULES` lists
 * each one. A platform whose aliasing supports prefixes should also route
 * unlisted subpaths under this prefix to a stub, so a new subpath added
 * upstream cannot pull the real SDK into a deployed bundle.
 */
export const MCP_SDK_SUBPATH_PREFIX = '@modelcontextprotocol/sdk/'

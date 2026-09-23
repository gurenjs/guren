/**
 * Build-time helpers shared by the deploy plugins (cloudflare, lambda, vercel).
 * Internal (`contributing/api-stability.md`): deep import only, never re-exported
 * from `@guren/core`. Imports only builtins and shared constants so a plugin build never drags
 * the runtime in; `deploy-build.test.ts` asserts that of the built artifact.
 * Platform decisions (messages, stub delivery, whether a missing `build` script is
 * fatal, SSR renderer verification) stay per-plugin. A helper that *relates* two
 * paths canonicalizes both first; one that reads or writes a single path does not.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export type PathLike = string | URL

/**
 * The agent registry (RFC 0017 §3), at a path neither side may choose. Shared
 * rather than spelled twice: `guren check` reads it as source and a deploy build
 * reads it to generate the worker's Durable Object exports, so a second spelling
 * is a deploy exporting no agents while the check calls them registered.
 */
export { AGENTS_CONFIG_FILE } from '@guren/server/internal/app-conventions'

export type ManifestEntry = {
  file?: string
  css?: string[]
}

export type Manifest = Record<string, ManifestEntry>

export function resolvePathLike(value: PathLike): string {
  return value instanceof URL ? fileURLToPath(value) : resolve(String(value))
}

/**
 * Read the first manifest that parses, in either Vite layout (`.vite/manifest.json`,
 * then flat `manifest.json`), and report its path: a caller publishing the location
 * must name the file actually parsed, not the malformed one that was skipped. What a
 * missing manifest means is the caller's call.
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

/**
 * Layouts `readManifest` accepts, `.vite/` first (Vite >= 5 writes it there; a flat
 * file beside it is likely stale). Must agree with `clientManifestCandidates` in
 * @guren/server's http/vite-manifest.ts, pinned by tests/http/vite-manifest.test.ts,
 * or local and deployed asset versions diverge.
 */
function manifestPaths(dir: string): [string, string] {
  return [resolve(dir, '.vite/manifest.json'), resolve(dir, 'manifest.json')]
}

/**
 * The one statement of where the client manifest lives: `<publicDir>/assets`, either
 * layout. `resolveClientAssetEnv` and `clientManifestJson` both read through here.
 */
function readClientManifest(publicDir: string): Manifest | undefined {
  return readManifest(...manifestPaths(resolve(publicDir, 'assets')))?.manifest
}

/**
 * Resolve symlinks in the existing parts of `path`, keeping trailing components that
 * do not exist yet (`realpathSync` throws on a first build's output dir). Twin of
 * `realpathNearestExisting` in @guren/cli's plugin-manifest.ts, copied because this
 * module imports only node builtins. Only ENOENT walks up; any other failure
 * surfaces, since both callers relate two paths and must not answer from a guess.
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
 * Throw unless `out` is safe to delete: neither the app root nor a directory
 * containing it. Both paths are canonicalized (a lexical compare accepts an
 * `outputDir` that reaches the root through links). Containment uses `relative`,
 * not a prefix test (`out + sep` is `//` at the root, letting `'/'` through), and
 * escape means `'..'` or a `'../'` prefix, so `..-source` inside `out` is not one.
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
 * Delete the output directory after checking it is safe to delete. One call on
 * purpose: a plugin that carried only the delete has already shipped.
 * @param label Platform name for the error message, e.g. `'Lambda build'`.
 */
export function resetOutputDir(out: string, root: string, label: string): void {
  assertOutputDirOutsideRoot(out, root, label)

  if (existsSync(out)) {
    rmSync(out, { recursive: true, force: true })
  }
}

/**
 * POSIX relative specifier for importing `target` from a module written into
 * `fromDir`. Both paths are canonicalized: the bundler resolves the emitted module
 * from its real path, and a link that changes depth would leave the specifier a
 * `..` short.
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

/**
 * The URL prefix built client assets are addressed by: the Vite `base` the Guren
 * plugin derives from `outDir: 'public/assets'`, which its modulepreload helper
 * prefixes. Must equal `PUBLIC_ASSETS_URL_PREFIX` in @guren/server's
 * http/vite-manifest.ts; an entry under another prefix loads every lazy chunk
 * twice, once per URL. `deploy-build.test.ts` pins it against the Vite plugin.
 */
export const CLIENT_ASSETS_URL_PREFIX = '/public/assets/'

export interface ClientAssetEnv {
  entry?: string
  styles?: string
}

/**
 * Locate the built client entry and its CSS in the Vite client manifest, as
 * `CLIENT_ASSETS_URL_PREFIX` URLs for the Inertia head. Takes the public directory
 * so a custom `publicDir` is honoured.
 * @param label Platform name for the warning message, e.g. `'Lambda build'`.
 */
export function resolveClientAssetEnv(
  publicDir: string,
  clientEntryKey: string,
  label: string,
): ClientAssetEnv {
  const manifest = readClientManifest(publicDir)

  const entry = manifest?.[clientEntryKey]
  if (!entry?.file) {
    console.warn(
      `${label}: no client manifest entry for "${clientEntryKey}"; GUREN_INERTIA_ENTRY will not be set.`,
    )
    return {}
  }

  return {
    entry: `${CLIENT_ASSETS_URL_PREFIX}${entry.file}`,
    styles: entry.css?.length
      ? entry.css.map((file) => `${CLIENT_ASSETS_URL_PREFIX}${file}`).join(',')
      : undefined,
  }
}

/**
 * The client manifest as JSON for runtime injection (`GUREN_VITE_MANIFEST`): a
 * bundled function has no `public/assets/manifest.json`. Separate from
 * `resolveClientAssetEnv`, which answers only for the client entry. Trimmed to
 * `file`/`css` per entry (all the runtime reads; chunk graph metadata dominates
 * size and Workers caps bundles); a parseable non-manifest is rejected here.
 */
export function clientManifestJson(publicDir: string): string | undefined {
  const manifest: unknown = readClientManifest(publicDir)
  if (manifest === undefined) {
    return undefined
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return undefined
  }

  const trimmed: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(manifest)) {
    if (typeof entry === 'string' || Array.isArray(entry)) {
      trimmed[key] = entry
      continue
    }
    if (typeof entry !== 'object' || entry === null) {
      continue
    }

    const kept: { file?: string; css?: string[] } = {}
    if (typeof entry.file === 'string') {
      kept.file = entry.file
    }
    if (Array.isArray(entry.css) && entry.css.length > 0) {
      kept.css = entry.css
    }
    if (kept.file !== undefined || kept.css !== undefined) {
      trimmed[key] = kept
    }
  }

  return JSON.stringify(trimmed)
}

const TRANSLATIONS_DIR = 'lang'

/**
 * Every `lang/<locale>/<namespace>.json` as `{ locale: { namespace: messages } }`
 * JSON, for runtime injection (`GUREN_TRANSLATIONS`): no deploy target ships
 * `lang/`. Same walk and parse tolerance as `JsonLoader` in @guren/server and
 * `readTranslationCatalogs` in @guren/cli. Undefined when nothing is readable.
 * @param label Platform name for the warning message, e.g. `'Lambda build'`.
 */
export function translationCatalogJson(root: string, label: string): string | undefined {
  const base = resolve(root, TRANSLATIONS_DIR)

  let locales: string[]
  try {
    locales = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return undefined
  }

  const catalog: Record<string, Record<string, unknown>> = {}
  for (const locale of locales) {
    const messages: Record<string, unknown> = {}
    let files: string[]
    try {
      files = readdirSync(resolve(base, locale)).filter((file) => extname(file) === '.json').sort()
    } catch {
      continue
    }

    for (const file of files) {
      try {
        messages[basename(file, '.json')] = JSON.parse(readFileSync(resolve(base, locale, file), 'utf8'))
      } catch {
        console.warn(
          `${label}: ${TRANSLATIONS_DIR}/${locale}/${file} is not valid JSON and is left out of the deployed translations.`,
        )
      }
    }

    if (Object.keys(messages).length > 0) {
      catalog[locale] = messages
    }
  }

  return Object.keys(catalog).length > 0 ? JSON.stringify(catalog) : undefined
}

/**
 * What a deploy build bakes into the bundle, keyed by the `process.env` name
 * @guren/server reads: the client manifest for viteAsset() and the lang/ catalogs
 * for createApp({ i18n }). No target ships those files, and platform environment
 * configuration is size-capped (Lambda: 4KB total), so neither goes there.
 * @param label Platform name for warning messages, e.g. `'Lambda build'`.
 */
export function bundledRuntimeEnv(root: string, publicDir: string, label: string): Record<string, string> {
  const env: Record<string, string> = {}

  const manifest = clientManifestJson(publicDir)
  if (manifest) {
    env.GUREN_VITE_MANIFEST = manifest
  }
  const translations = translationCatalogJson(root, label)
  if (translations) {
    env.GUREN_TRANSLATIONS = translations
  }

  return env
}

/**
 * Absolute path of the built SSR entry chunk, or undefined without an SSR build.
 * Whether the chunk exports a renderer is the caller's check: platforms disagree
 * on importing it during a build.
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
 * Runtime locations of a staged SSR bundle, for platforms that copy `ssrDir` under
 * the function root; `prefix` is where the caller stages it. The manifest path is
 * the file that parsed, not the first that exists (a malformed `.vite/` file beside
 * a valid flat one). Optional only for the race where the manifest vanishes after
 * `resolveSsrEntryFile`.
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
 * Delete the dev-mode `index.html` shell from a statically served directory: every
 * deploy target answers for its static directory before the function runs, so the
 * shell shadows the app's root route. Exact name only (the framework writes it).
 * Separate from `stageStaticAssets` because `@guren/plugin-vercel` stages `public/`
 * itself and needs this rule alone.
 */
export function removeShadowingIndex(assetsOut: string): void {
  const shadowingIndex = resolve(assetsOut, 'index.html')
  if (existsSync(shadowingIndex)) {
    rmSync(shadowingIndex)
  }
}

/**
 * Copy `public/` into a platform's static staging directory, with the built assets
 * only under `CLIENT_ASSETS_URL_PREFIX`, the one prefix the HTML and the chunks
 * address: a second copy at `assets/` would answer, and so hide, a URL that drifted
 * off it. Vite empties `public/assets/` on every build, so it holds nothing else.
 * Also applies `removeShadowingIndex`.
 */
export function stageStaticAssets(publicDir: string, assetsOut: string): void {
  mkdirSync(assetsOut, { recursive: true })

  if (!existsSync(publicDir)) {
    return
  }

  const clientAssetsDir = resolve(publicDir, 'assets')
  cpSync(publicDir, assetsOut, {
    recursive: true,
    filter: (source) => resolve(source) !== clientAssetsDir,
  })

  removeShadowingIndex(assetsOut)

  if (existsSync(clientAssetsDir)) {
    cpSync(clientAssetsDir, resolve(assetsOut, 'public/assets'), { recursive: true })
  }
}

/**
 * Extensions a browser renders as a document, for platforms serving `public/`
 * before the app runs: exactly what `@guren/server`'s `rendersAsDocument` matches
 * over Hono's mime table (`tests/http/static-documents.test.ts` fails on drift).
 * Like the framework it misses `.xsl` (Hono names no extension) and extension
 * case, which each plugin closes as its own matcher allows.
 */
export const DOCUMENT_ASSET_EXTENSIONS = ['htm', 'html', 'svg', 'xhtml', 'xml'] as const

/**
 * The headers `applyDocumentDisposition` sets: `attachment` is honoured for
 * navigations and ignored for subresource loads, so `<img>` and CSS `url()` keep
 * working while a directly opened URL downloads; `nosniff` stops browser promotion.
 */
export const DOCUMENT_ASSET_HEADERS: Readonly<Record<string, string>> = {
  'Content-Disposition': 'attachment',
  'X-Content-Type-Options': 'nosniff',
}

/**
 * What a dev-only module is needed for, so a plugin can word its own message.
 * `mcp` is the `@guren/cli` entry. Deploy plugins already on npm key their message
 * tables on these values, so renaming one breaks their builds until core 2.0.
 */
export type DevOnlyModuleKind = 'sqlite' | 'vite' | 'mcp' | 'sql-driver'

export interface DevOnlyModule {
  readonly specifier: string
  readonly kind: DevOnlyModuleKind
  /**
   * Names the importing code destructures; a stub must declare every one or the
   * bundle fails with "no matching export". Empty means namespace access only.
   */
  readonly exportNames: readonly string[]
  /**
   * The package source that reaches this module, repo-relative. An entry is here
   * because one package imports it, so the module-graph check searches that package
   * alone: a stale entry cannot be kept alive by an unrelated package's import.
   */
  readonly importedBy: string
}

/**
 * Dev-only modules in the graph of any app importing `@guren/core`, listed here
 * because core alone sees the whole set (two plugin copies had drifted). Bundlers
 * follow even dynamic imports, so unstubbed they fail the build or ship dev tooling.
 * SQL clients are deliberately elsewhere (`SQL_CLIENT_MODULES`): dev-only on
 * Workers, load-bearing on Lambda/Vercel. `as const` keys consumers' exhaustive tables.
 */
export const DEV_ONLY_MODULES = [
  { specifier: 'bun:sqlite', kind: 'sqlite', exportNames: ['Database'], importedBy: 'packages/orm/src' },
  { specifier: 'vite', kind: 'vite', exportNames: ['createServer'], importedBy: 'packages/server/src' },
  { specifier: '@guren/cli', kind: 'mcp', exportNames: [], importedBy: 'packages/server/src' },
] as const satisfies readonly DevOnlyModule[]

/** One entry of `DEV_ONLY_MODULES`, with its `kind` still narrowed. */
export type DevOnlyModuleEntry = (typeof DEV_ONLY_MODULES)[number]

/** The package an app declares to opt into the App MCP endpoint. */
export const MCP_PLUGIN_PACKAGE = '@guren/plugin-mcp'

// The four names below serve no build in this repo. Deploy plugins already on npm
// import them from this subpath under a caret on core, and a named ESM import the
// installed copy lacks fails when the plugin's root module links, so an app that
// updates core alone would stop booting. They stay until core 2.0.

/** @deprecated The v1 MCP transport, which no Guren package imports since RFC 0028. */
export const MCP_TRANSPORT_SPECIFIER =
  '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

/** @deprecated The v1 MCP SDK subpath prefix, which no Guren package imports since RFC 0028. */
export const MCP_SDK_SUBPATH_PREFIX = '@modelcontextprotocol/sdk/'

/**
 * @deprecated Whether `@guren/plugin-mcp` is a runtime dependency. No longer decides
 * any stub: nothing imports the v1 transport it once kept out of the stub list.
 */
export function appUsesMcpPlugin(root: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const dependencies = manifest.dependencies
    return (
      typeof dependencies === 'object'
      && dependencies !== null
      && MCP_PLUGIN_PACKAGE in dependencies
    )
  } catch {
    return false
  }
}

/**
 * @deprecated `DEV_ONLY_MODULES`, whatever `mcpPlugin` says: the v1 transport entry
 * this once dropped is no longer listed.
 */
export function stubbableDevOnlyModules(_options: {
  mcpPlugin: boolean
}): readonly DevOnlyModuleEntry[] {
  return DEV_ONLY_MODULES
}

/** A database `@guren/orm` can connect through, named after the factory the app's config calls. */
export type DatabaseDialect = 'postgres' | 'mysql' | 'sqlite' | 'aws-data-api' | 'd1'

/**
 * The `@guren/orm` factory names an app's config calls, with each one's dialect.
 * Taken from `@guren/core`'s export allowlist (pinned by a test), not the ORM's
 * files: it is `createMySqlDatabase`, and a filter on a name nobody exports stubs
 * nothing, silently.
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
 * Client libraries the Postgres, MySQL and Aurora Data API factories reach for.
 * Apart from `DEV_ONLY_MODULES`: unreachable on Workers (D1 only), load-bearing on
 * Lambda/Vercel, which stub only undeclared dialects (`unusedSqlClients`). Stub the
 * client *and* drizzle's entry importing it, or a D1 app fails to resolve `postgres`.
 * `mysql2/promise` lists its whole public API, not just drizzle's `createPool` (#507).
 */
export const SQL_CLIENT_MODULES = [
  { specifier: 'postgres', kind: 'sql-driver', dialect: 'postgres', exportNames: [], importedBy: 'packages/orm/src' },
  { specifier: 'mysql2', kind: 'sql-driver', dialect: 'mysql', exportNames: [], importedBy: 'packages/orm/src' },
  {
    specifier: 'mysql2/promise',
    kind: 'sql-driver',
    dialect: 'mysql',
    exportNames: [
      'createConnection',
      'createPool',
      'createPoolCluster',
      'escape',
      'escapeId',
      'format',
      'raw',
      'Connection',
      'PoolConnection',
      'PromisePool',
      'PromiseConnection',
      'PromisePoolConnection',
      'Types',
      'Charsets',
      'CharsetToEncoding',
      'setMaxParserCache',
      'clearParserCache',
    ],
    importedBy: 'packages/orm/src',
  },
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
    importedBy: 'packages/orm/src',
  },
] as const satisfies readonly SqlClientModule[]

export type SqlClientSpecifier = (typeof SQL_CLIENT_MODULES)[number]['specifier']

/**
 * Where an app declares its database, in lookup order. Same pair `guren doctor`
 * checks, copied because this module imports only node builtins; a change to
 * either belongs in both.
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
 * Which databases an app connects to, read off its config. A union, never a single
 * answer: a config may name two factories and pick at runtime (D1 plus sqlite).
 * A name scan, not a parse: every way of being wrong about a name that is in the
 * file errs toward reporting an unused dialect, which only stubs fewer clients.
 * A factory reached without being named reports nothing, and nothing is stubbed.
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
 * Reject a dialect list that is empty or names a non-dialect: either stubs the
 * client the app needs (`[]` stubs every one, `['postgress']` the Postgres one),
 * and the bundle builds clean but cannot reach its database. Not fail-open: this
 * is a caller's explicit override, and falling back to detection would stub by the
 * very config being overridden.
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
 * The database clients an app does not connect through, for Lambda and Vercel
 * (on Workers every client is unreachable). Fails open: unreadable dialects warn
 * and stub nothing, because under-stubbing fails loudly at build time while
 * over-stubbing ships a bundle that cannot reach its database in production.
 * @param dialects Overrides detection when the caller already knows.
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
 * A JavaScript string literal for `value`. `JSON.stringify` alone is not one: it
 * leaves U+2028/U+2029 raw, which JavaScript below ES2019 reads as line terminators.
 */
function toJsStringLiteral(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/**
 * Source for a stub replacing one dev-only module. Every destructured name must be
 * present or the bundle fails with "no matching export", and each is a throwing
 * *function* because stubbed names mix constructors and plain calls (a class
 * called without `new` would hide the real reason).
 * @param message Platform-specific explanation, including the replacement API.
 */
export function renderDevOnlyStub(module: Pick<DevOnlyModule, 'exportNames'>, message: string): string {
  // The message lands in the file twice with different escaping: as the thrown
  // error's string literal and as comment text, where a line terminator would end
  // the comment and run what follows as code.
  const comment = message.replace(/[\r\n\u2028\u2029]+/g, ' ')
  const error = `throw new Error(${toJsStringLiteral(message)})`
  const throwing = module.exportNames
    .map((name) => `export function ${name}() { ${error} }`)
    .join('\n')

  // The default export is a *function*: `drizzle-orm/postgres-js` does
  // `import pgClient from "postgres"` and calls it, and a module with no default
  // fails the bundle. Named exports are attached so object-shaped access still works.
  const named = module.exportNames.length > 0 ? `, { ${module.exportNames.join(', ')} }` : ''
  const fallback = `function unavailable() { ${error} }`
  return `// ${comment}\n${throwing}\n${fallback}\nexport default Object.assign(unavailable${named})\n`
}

/**
 * `Bun.build` minify options for a deploy bundle. Jobs, events, notifications and
 * agents are stored under their class name, so identifiers stay unmangled, and
 * `keepNames` restores the name syntax minification drops from a named class or
 * function expression. It never replaces `identifiers: false`: on Bun 1.3.14 and
 * 1.4.2 mangling wins. Neither restores a cross-module rename (`renamedNameKeyedClasses`).
 */
export const BUN_DEPLOY_MINIFY = { whitespace: true, syntax: true, identifiers: false, keepNames: true } as const

/**
 * Framework bases whose subclasses are stored under their class name. A record kind
 * can pin that name; a model cannot: attachments and `morphMany` write `model.name`
 * while `Model.morphMap` finds the model by its source name, so a rename splits them.
 */
const NAME_KEYED_BASES: ReadonlyMap<string, NameKeyedKind> = new Map([
  ...['Job', 'Event', 'Notification', 'Agent'].map((base) => [base, 'record'] as const),
  ...['Model', 'AuthenticatableModel', 'defineModel', 'Attachable', 'SoftDeletes'].map((base) => [base, 'model'] as const),
])
const NAME_PIN = /\bstatic\s+(?:override\s+)?(?:jobName|eventName|agentName)\b|\bget\s+type\s*\(/
// A heritage is read as its last identifier, so `core.Job` and `import_core.defineModel(…)` count.
const HERITAGE = String.raw`\s+extends\s+(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)`
const SOURCE_CLASS = new RegExp(
  String.raw`^[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:abstract[ \t]+)?class[ \t]+([A-Za-z_$][\w$]*)(?:[ \t]*<[^{>\n]*>)?(?:${HERITAGE})?`,
  'gm',
)
const BUNDLED_CLASS = new RegExp(String.raw`(?:^|[^\w$.])class\s+([A-Za-z_$][\w$]*)(?:${HERITAGE})?`, 'g')
// `[^{}]`, not `[^}]`: an unclosed `import {` must not rescan to the end of the file.
const NAMED_IMPORTS = /import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^{}]*)\}\s*from\s*['"]([^'"]+)['"]/g
const IMPORT_SPECIFIER = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/

type NameKeyedKind = 'record' | 'model'

export interface RenamedNameKeyedClass {
  /** The name in source, which `bun run` reports. */
  readonly name: string
  /** The name the bundle declares instead, and so the class's runtime `.name`. */
  readonly bundledAs: string
  /** `record`: a job, event, notification or agent, which can pin its name. */
  readonly kind: NameKeyedKind
  /** The app files declaring such a class called `name`. */
  readonly files: readonly string[]
}

/**
 * App models and unpinned records the bundle renamed to `<name><n>`, which happens when
 * another module declares the same top-level name. A declaration counts only when the
 * numbered class extends its base, so a renamed dependency class is not the app's. Read
 * with regexes, since this module imports only builtins: a base built by an expression
 * the patterns above do not match (a mixin they do not name) is missed, not guessed.
 */
export function renamedNameKeyedClasses(
  bundle: string,
  sources: ReadonlyArray<{ readonly file: string; readonly text: string }>,
): RenamedNameKeyedClass[] {
  interface Declaration {
    file: string
    /** The exported name of the base, so `Job` for `import { Job as QueuedJob }`. */
    base: string | undefined
    fromFramework: boolean
    pinned: boolean
  }
  const declared = new Map<string, Declaration[]>()
  for (const { file, text } of sources) {
    const imports = namedImports(text)
    const pinned = NAME_PIN.test(text)
    for (const [, name, local] of text.matchAll(SOURCE_CLASS)) {
      const imported = local === undefined ? undefined : imports.get(local)
      const entries = declared.get(name!) ?? []
      entries.push({ file, base: imported?.name ?? local, fromFramework: imported?.fromFramework ?? false, pinned })
      declared.set(name!, entries)
    }
  }

  // An app class sharing a framework base's name (a calendar `Event` model) shadows it,
  // unless the file imports that name from `@guren/*`.
  const kindOf = (entry: Declaration, seen = new Set<string>()): NameKeyedKind | undefined => {
    if (entry.base === undefined) return undefined
    const own = entry.fromFramework ? undefined : declared.get(entry.base)
    if (own === undefined) return NAME_KEYED_BASES.get(entry.base)
    if (seen.has(entry.base)) return undefined
    seen.add(entry.base)
    for (const parent of own) {
      const inherited = kindOf(parent, seen)
      if (inherited !== undefined) return inherited
    }
    return undefined
  }

  const bundledBases = new Map<string, Set<string>>()
  for (const [, bundledAs, base] of bundle.matchAll(BUNDLED_CLASS)) {
    if (base === undefined) continue
    const bases = bundledBases.get(bundledAs!) ?? new Set()
    bases.add(stem(base))
    bundledBases.set(bundledAs!, bases)
  }

  const renamed: RenamedNameKeyedClass[] = []
  for (const [bundledAs, bases] of bundledBases) {
    const name = withoutNumericSuffix(bundledAs)
    if (name === undefined || declared.has(bundledAs)) continue
    const files = new Map<NameKeyedKind, string[]>()
    for (const entry of declared.get(name) ?? []) {
      if (entry.base === undefined || !bases.has(stem(entry.base))) continue
      const kind = kindOf(entry)
      if (kind === undefined || (kind === 'record' && entry.pinned)) continue
      files.set(kind, [...(files.get(kind) ?? []), entry.file])
    }
    for (const [kind, list] of files) renamed.push({ name, bundledAs, kind, files: list.sort() })
  }
  return renamed
}

// A scan rather than `/^(.+?)\d+$/`, which backtracks polynomially on a long digit run.
function withoutNumericSuffix(name: string): string | undefined {
  let end = name.length
  while (end > 0 && name.charCodeAt(end - 1) >= 48 && name.charCodeAt(end - 1) <= 57) end--
  return end > 0 && end < name.length ? name.slice(0, end) : undefined
}

// A base may be renamed in the bundle too, so bases compare without a numeric suffix.
function stem(name: string): string {
  return withoutNumericSuffix(name) ?? name
}

/** Local name → exported name, for a file's `import { A as B } from '…'` statements. */
function namedImports(text: string): Map<string, { name: string; fromFramework: boolean }> {
  const imports = new Map<string, { name: string; fromFramework: boolean }>()
  for (const [, specifiers, from] of text.matchAll(NAMED_IMPORTS)) {
    for (const specifier of specifiers!.split(',')) {
      const match = IMPORT_SPECIFIER.exec(specifier.trim())
      if (match) imports.set(match[2] ?? match[1]!, { name: match[1]!, fromFramework: from!.startsWith('@guren/') })
    }
  }
  return imports
}

/** The part of a `Bun.build` result the reporter reads, structural so this module needs no bun-types. */
export interface BundleResultLike {
  readonly outputs: ReadonlyArray<{ readonly kind: string; text(): Promise<string> }>
  readonly metafile?: { readonly inputs: Readonly<Record<string, unknown>> }
}

/**
 * Warns about each `renamedNameKeyedClasses` result of a `Bun.build` run with
 * `metafile: true`, whose input paths (relative to the cwd) are the sources read.
 * Module dependencies are skipped, and so is an input that will not read, such as a
 * plugin namespace.
 */
export async function reportRenamedNameKeyedClasses(
  result: BundleResultLike,
  options: { root: string; label: string },
): Promise<void> {
  const code = result.outputs.filter((output) => output.kind === 'entry-point' || output.kind === 'chunk')
  const bundle = (await Promise.all(code.map((output) => output.text()))).join('\n')
  const root = realpathOfNearestExisting(options.root)
  const sources: Array<{ file: string; text: string }> = []
  for (const input of Object.keys(result.metafile?.inputs ?? {})) {
    if (/(?:^|[\\/])node_modules[\\/]/.test(input)) continue
    try {
      const path = realpathSync(resolve(input))
      sources.push({ file: relative(root, path), text: readFileSync(path, 'utf8') })
    } catch {
      continue
    }
  }

  for (const { name, bundledAs, kind, files } of renamedNameKeyedClasses(bundle, sources)) {
    const declares = `${files.join(', ')} ${files.length === 1 ? 'declares' : 'declare'}`
    const found =
      kind === 'record'
        ? `${declares} a job, event, notification or agent named ${name}, which is stored under its class name: ` +
          'rename it, or pin `static jobName`, `static eventName`, `get type()` or `static agentName`.'
        : `${declares} a model named ${name}. Its attachments and polymorphic relations, if it has any, are stored ` +
          `as ${bundledAs} while \`Model.morphMap\` looks it up as ${name}: a model has no name to pin, so rename the ` +
          `class (rows already stored as ${bundledAs} need updating).`
    console.warn(
      `${options.label}: the bundle names a class ${name} as ${bundledAs}, because another module declares ` +
        `${name} too and import order picks which one keeps it. ${found}`,
    )
  }
}

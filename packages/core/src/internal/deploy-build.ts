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
 * built artifact — the property would otherwise break silently the day tsup
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
 * The database client libraries `@guren/orm`'s Postgres, MySQL and Aurora
 * Data API factories reach for.
 *
 * They sit apart from `DEV_ONLY_MODULES` because whether they are dead weight
 * depends on the platform: on Workers, D1 is the only database there is, so
 * every one of these is unreachable; on Lambda and Vercel the app connects to
 * Postgres through them and stubbing them would break a working deploy.
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
  { specifier: 'postgres', kind: 'sql-driver', exportNames: [] },
  { specifier: 'mysql2', kind: 'sql-driver', exportNames: [] },
  { specifier: 'mysql2/promise', kind: 'sql-driver', exportNames: ['createPool'] },
  {
    specifier: '@aws-sdk/client-rds-data',
    kind: 'sql-driver',
    exportNames: [
      'RDSDataClient',
      'BeginTransactionCommand',
      'CommitTransactionCommand',
      'ExecuteStatementCommand',
      'RollbackTransactionCommand',
    ],
  },
] as const satisfies readonly DevOnlyModule[]

export type SqlClientSpecifier = (typeof SQL_CLIENT_MODULES)[number]['specifier']

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

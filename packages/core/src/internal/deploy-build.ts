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
 * Read the first manifest that exists, tolerating both Vite layouts
 * (`.vite/manifest.json` and the flat `manifest.json` older configs emit).
 * A malformed file is skipped rather than fatal — the caller decides what a
 * missing manifest means for its platform.
 */
export function loadManifest(...paths: string[]): Manifest | undefined {
  return readManifest(...paths)?.manifest
}

/**
 * As `loadManifest`, but also reports which path was read. A caller that
 * publishes the manifest location to the runtime has to name the file that was
 * actually parsed: testing which one *exists* picks the malformed one that
 * `loadManifest` just skipped.
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

/** The two layouts `loadManifest` accepts, in preference order. */
export function manifestPaths(dir: string): [string, string] {
  return [resolve(dir, '.vite/manifest.json'), resolve(dir, 'manifest.json')]
}

/**
 * Resolve symlinks in the parts of `path` that exist, keeping the trailing
 * components that do not. `realpathSync` throws on a path that is not there
 * yet, and an output directory usually is not on a first build.
 */
function realpathOfNearestExisting(path: string): string {
  let existing = path
  const missing: string[] = []

  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) {
      return path
    }
    missing.unshift(basename(existing))
    existing = parent
  }

  return resolve(realpathSync(existing), ...missing)
}

/**
 * Throw unless `out` is safe to delete: it must be neither the app root nor a
 * directory containing it.
 *
 * Both paths are resolved through their symlinks first, because the delete
 * that follows does too. Comparing lexically accepts `outputDir` values that
 * reach the app root the long way — on macOS `/tmp` is itself a symlink to
 * `/private/tmp`, so this is not a contrived case.
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
 * @param label Platform name for the error message, e.g. `'Lambda build'`.
 */
export function importSpecifier(fromDir: string, target: string, label: string): string {
  const rel = relative(fromDir, target)
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
  const manifest = loadManifest(...manifestPaths(resolve(publicDir, 'assets')))

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
  const manifest = loadManifest(...manifestPaths(ssrDir))

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
 * Path of the SSR manifest that `resolveSsrEntryFile` actually read, relative
 * to the function root, for platforms that pass it to the runtime.
 *
 * Derived from the file that parsed rather than the first one that exists:
 * both Vite layouts occur in the wild, and a malformed `.vite/manifest.json`
 * alongside a valid flat one would otherwise publish the path to the file that
 * was skipped.
 */
export function ssrManifestRelativePath(ssrDir: string, prefix: string): string | undefined {
  const read = readManifest(...manifestPaths(ssrDir))
  if (!read) {
    return undefined
  }

  return `${prefix}/${relative(ssrDir, read.path).split(sep).join('/')}`
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
export type DevOnlyModuleKind = 'sqlite' | 'vite' | 'mcp'

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
export function renderDevOnlyStub(module: DevOnlyModule, message: string): string {
  if (module.exportNames.length === 0) {
    return `// ${message}\nexport {}\n`
  }

  const throwing = module.exportNames
    .map((name) => `export function ${name}() { throw new Error(${JSON.stringify(message)}) }`)
    .join('\n')
  return `${throwing}\nexport default { ${module.exportNames.join(', ')} }\n`
}

/**
 * The MCP SDK is only ever reached through subpaths, and a bundler alias on a
 * package name does not cover them — which is why `DEV_ONLY_MODULES` lists
 * each one. A platform whose aliasing supports prefixes should also route
 * unlisted subpaths under this prefix to a stub, so a new subpath added
 * upstream cannot pull the real SDK into a deployed bundle.
 */
export const MCP_SDK_SUBPATH_PREFIX = '@modelcontextprotocol/sdk/'

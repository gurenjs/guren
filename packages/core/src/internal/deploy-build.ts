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
 * `node:` builtins belong here.
 *
 * What does *not* belong here: anything a platform legitimately decides for
 * itself. The stub *rendering* (Workers needs a file per alias, Lambda needs
 * inline source for its bundler plugin), the message text naming a platform
 * and its replacement API, whether a missing `build` script is fatal, and how
 * an SSR bundle's renderer export is verified are all per-plugin by design.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export type PathLike = string | URL

export type ManifestEntry = {
  file?: string
  css?: string[]
}

export type Manifest = Record<string, ManifestEntry>

/** Accept both the `new URL('...', import.meta.url)` and plain-string forms. */
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
  for (const path of paths) {
    if (!existsSync(path)) {
      continue
    }

    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Manifest
    } catch {
      continue
    }
  }

  return undefined
}

/**
 * Reject an output directory that is the app root or contains it. Every plugin
 * deletes its output directory on each build, so this is the guard between a
 * mistyped option and `rm -rf` over a project.
 *
 * Compared with `relative` rather than a string prefix: `out + sep` is `//` at
 * the filesystem root, which no absolute path is prefixed by, so a prefix test
 * lets `outputDir: '/'` through.
 *
 * @param label Platform name for the error message, e.g. `'Lambda build'`.
 */
export function assertOutputDirOutsideRoot(out: string, root: string, label: string): void {
  const outToRoot = relative(out, root)
  if (outToRoot === '' || (!outToRoot.startsWith('..') && !isAbsolute(outToRoot))) {
    throw new Error(
      `${label}: outputDir (${out}) must be a directory outside or below the app root, never the root itself or a parent of it — it is deleted on every build.`,
    )
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
  const manifest = loadManifest(
    resolve(publicDir, 'assets/.vite/manifest.json'),
    resolve(publicDir, 'assets/manifest.json'),
  )

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
 * Modules in every Guren app's graph that cannot run off Bun, reached only
 * through dev-time branches. This list describes `@guren/core`'s own imports,
 * which is why it lives here: it changes when the framework's module graph
 * changes, and a deploy plugin that misses an entry ships a broken bundle.
 *
 * Bundlers follow these imports even when they are dynamic, so without stubs
 * the build either fails to resolve them or ships megabytes of dev tooling.
 *
 * - `sqlite` — the local sqlite ORM factory, opposite the platform's own
 *   database branch in `config/database.ts`.
 * - `vite` — the dev asset server `Application` starts when serving locally.
 * - `mcp` — the opt-in MCP endpoint's lazy imports, which drag the CLI
 *   generators (and Babel) plus the MCP SDK in behind them.
 */
export const DEV_ONLY_MODULES: readonly DevOnlyModule[] = [
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
]

/**
 * The MCP SDK is only ever reached through subpaths, and a bundler alias on a
 * package name does not cover them — which is why `DEV_ONLY_MODULES` lists
 * each one. A platform whose aliasing supports prefixes should also route
 * unlisted subpaths under this prefix to a stub, so a new subpath added
 * upstream cannot pull the real SDK into a deployed bundle.
 */
export const MCP_SDK_SUBPATH_PREFIX = '@modelcontextprotocol/sdk/'

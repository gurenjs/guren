import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  appUsesMcpPlugin,
  DEV_ONLY_MODULES,
  MCP_PLUGIN_PACKAGE,
  MCP_TRANSPORT_SPECIFIER,
  SQL_CLIENT_MODULES,
  clientManifestJson,
  DOCUMENT_ASSET_EXTENSIONS,
  DOCUMENT_ASSET_HEADERS,
  importSpecifier,
  renderDevOnlyStub,
  stubbableDevOnlyModules,
  assertOutputDirOutsideRoot,
  resetOutputDir,
  resolveClientAssetEnv,
  resolvePathLike,
  resolveSsrEntryFile,
  stageStaticAssets,
  type ClientAssetEnv,
  type DevOnlyModule,
  type DevOnlySpecifier,
  type SqlClientSpecifier,
  type PathLike,
} from '@guren/core/internal/deploy-build'

import {
  MCP_OAUTH_REGISTRAR,
  MCP_OAUTH_ROUTES_FILE,
  MCP_OAUTH_TEMPLATE_FILES,
  loadMcpOAuthTemplate,
} from './templates'

interface PackageJsonLike {
  name?: string
  scripts?: Record<string, string>
}

export interface BuildCloudflareOutputOptions {
  /** App root directory. Defaults to the current working directory. */
  rootDir?: PathLike
  /** Output directory for the assembled worker. Defaults to `<root>/.cloudflare`. */
  outputDir?: PathLike
  /** Module that default-exports the Guren Application. Defaults to `<root>/src/app.ts`. */
  appEntry?: PathLike
  /** Static files directory copied into Workers Static Assets. Defaults to `<root>/public`. */
  publicDir?: PathLike
  /** Vite SSR build output. Defaults to `<root>/.guren/ssr`. */
  ssrDir?: PathLike
  /** Client manifest key for the frontend entry. Defaults to `resources/js/app.tsx`. */
  clientEntryKey?: string
  /** SSR manifest key for the server entry. Defaults to `resources/js/ssr.tsx`. */
  ssrEntryKey?: string
  /** Skip running the app's `build` script before assembling output. */
  skipAppBuild?: boolean
  /**
   * Front the worker with `@cloudflare/workers-oauth-provider`, so the App MCP
   * endpoint is reached by OAuth-authorized clients instead of bearer tokens
   * (RFC 0016 §7).
   *
   * A **build** option rather than plugin configuration: the generator runs in
   * another process and cannot read what `mcpPlugin()` was passed. Nothing
   * records the choice, so pass it on every build that wants it; a committed
   * config carrying the OAuth binding without the flag is warned about.
   */
  mcpOAuth?: boolean
  /**
   * Path the App MCP endpoint is mounted at, used as the OAuth provider's
   * protected `apiRoute`. Only read when `mcpOAuth` is on.
   *
   * Defaults to `mcpPlugin()`'s own default; an app that passed
   * `mcpPlugin({ path })` must repeat it here. A provider protecting a path the
   * endpoint does not serve leaves the endpoint outside the OAuth boundary,
   * silently, because the request still reaches the app.
   */
  mcpPath?: string
}

/**
 * Assemble a deployable Cloudflare Workers directory (`.cloudflare/`) from a
 * built Guren app: a generated worker entry that statically wires the SSR
 * bundle, static assets for Workers Static Assets, and a one-time
 * `wrangler.jsonc` scaffold. Deploy with `wrangler deploy`.
 */
export async function buildCloudflareOutput(options: BuildCloudflareOutputOptions = {}): Promise<void> {
  const root = resolvePathLike(options.rootDir ?? process.cwd())
  const out = resolvePathLike(options.outputDir ?? resolve(root, '.cloudflare'))
  const appEntry = resolvePathLike(options.appEntry ?? resolve(root, 'src/app.ts'))
  const publicDir = resolvePathLike(options.publicDir ?? resolve(root, 'public'))
  const ssrDir = resolvePathLike(options.ssrDir ?? resolve(root, '.guren/ssr'))
  const clientEntryKey = options.clientEntryKey ?? 'resources/js/app.tsx'
  const ssrEntryKey = options.ssrEntryKey ?? 'resources/js/ssr.tsx'

  // Validated up front so a bad option fails before running the app build,
  // but the delete waits until every check below has passed — a failed build
  // must not take the previous deploy output with it.
  assertOutputDirOutsideRoot(out, root, 'Cloudflare build')
  assertWranglerJsoncIsAuthoritative(root)

  const packageJson = readPackageJson(root)
  // The App MCP opt-in is decided once and threaded to both halves below (the
  // guard on the committed config and the alias set the scaffold writes), so the
  // two cannot disagree. Parsing package.json twice is cheap; deciding twice is not.
  const mcpPlugin = appUsesMcpPlugin(root)

  const mcpOAuth = options.mcpOAuth === true
  const mcpPath = options.mcpPath ?? DEFAULT_MCP_PATH

  // Checked before the app build: these are one-line edits to files the developer
  // owns, and reporting them after minutes of Vite output is reporting them where
  // nobody reads.
  assertMcpTransportNotAliased(root, mcpPlugin)
  if (mcpOAuth) {
    assertMcpOAuthUsable(root, mcpPlugin)
    assertOAuthKvBound(root)
  }

  if (!options.skipAppBuild) {
    runAppBuild(root, packageJson.scripts ?? {})
  }

  if (!existsSync(appEntry)) {
    throw new Error(`Cloudflare build: app entry not found at ${appEntry}. Pass "appEntry" if your Application lives elsewhere.`)
  }

  const ssrImport = await resolveSsrImport(ssrDir, ssrEntryKey)
  const assetEnv = resolveClientAssetEnv(publicDir, clientEntryKey, 'Cloudflare build')
  const viteManifest = clientManifestJson(publicDir)

  resetOutputDir(out, root, 'Cloudflare build')

  // Workers Static Assets serves `/` from index.html BEFORE the worker runs,
  // and has no rewrites for the built assets' `/public/assets/` base — both
  // handled by the shared staging step.
  stageStaticAssets(publicDir, resolve(out, 'assets'))
  writeAssetHeaders(resolve(out, 'assets'))

  const workerEnv = renderWorkerEnvModule({ assetEnv, viteManifest })
  if (workerEnv) {
    writeFileSync(resolve(out, 'worker-env.js'), workerEnv)
  }
  writeFileSync(
    resolve(out, 'worker.js'),
    renderWorkerModule({
      out,
      appEntry,
      ssrImport,
      hasEnvModule: workerEnv !== undefined,
      mcpOAuth,
      mcpPath,
    }),
  )

  flattenD1Migrations(resolve(root, 'db/migrations'), resolve(out, 'd1-migrations'))

  writeDevOnlyStubs(out)

  if (mcpOAuth) {
    scaffoldConsentFlow(root)
  }

  scaffoldWranglerConfig(root, out, packageJson.name, mcpPlugin, mcpOAuth)
}

const MCP_UNAVAILABLE = 'The MCP endpoint is unavailable on Cloudflare Workers — it generates files on disk.'

/** `mcpPlugin()`'s own default mount path — see `BuildCloudflareOutputOptions.mcpPath`. */
const DEFAULT_MCP_PATH = '/mcp'

/** The OAuth provider package the generated worker imports, installed by the app. */
const OAUTH_PROVIDER_PACKAGE = '@cloudflare/workers-oauth-provider'

/** The subpath of `@guren/plugin-mcp` carrying the principal seam. */
const MCP_OAUTH_SEAM_SPECIFIER = '@guren/plugin-mcp/oauth'

/** The KV binding name `OAuthProvider` requires, fixed by the provider. */
const OAUTH_KV_BINDING = 'OAUTH_KV'

/** The three endpoints the provider owns or hands back, in one place. */
const OAUTH_ENDPOINTS = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  register: '/oauth/register',
} as const

/**
 * Refuse `--mcp-oauth` on an app that cannot serve it, before anything is built.
 * Both prerequisites are the app's own `dependencies`: `@guren/plugin-mcp` (or
 * there is no endpoint to front and the seam module is not installed) and
 * `@cloudflare/workers-oauth-provider`, which wrangler resolves from the *app's*
 * `node_modules`, so only apps opting in install it. Not `devDependencies`:
 * `wrangler deploy` resolves from a production install.
 */
function assertMcpOAuthUsable(root: string, mcpPlugin: boolean): void {
  if (!mcpPlugin) {
    throw new Error(
      `Cloudflare build: --mcp-oauth fronts the App MCP endpoint with an OAuth provider, but this app does not depend on ${MCP_PLUGIN_PACKAGE}, so it serves no such endpoint. Install and mount the plugin first:\n`
      + `  bun add ${MCP_PLUGIN_PACKAGE}\n`
      + '  # then add mcpPlugin() to createApp({ providers })\n'
      + 'Or drop --mcp-oauth to build the worker without the OAuth wrapping.',
    )
  }

  if (!appDependsOn(root, OAUTH_PROVIDER_PACKAGE)) {
    throw new Error(
      `Cloudflare build: --mcp-oauth generates a worker that imports ${OAUTH_PROVIDER_PACKAGE}, which this app does not depend on. Install it:\n`
      + `  bun add ${OAUTH_PROVIDER_PACKAGE}\n`
      + `It is not a dependency of @guren/plugin-cloudflare on purpose — only apps fronting the MCP endpoint with OAuth need it. A devDependency will not do: wrangler resolves the import at deploy time, from a production install.`,
    )
  }
}

/**
 * `OAuthProvider` stores clients, grants and tokens in a KV namespace bound as
 * `OAUTH_KV`, with no default: without the binding the worker deploys and then
 * fails on its first authorize request.
 *
 * Build-owned **only while the flag is on**, so the caller decides whether to
 * ask. A fresh scaffold gets the entry written; an existing `wrangler.jsonc` is
 * failed rather than warned, since the consequence is invisible in the build
 * output and the fix is a paste of JSON this can spell exactly. A config that
 * does not parse is left to {@link warnMissingBuildOwnedKeys}.
 */
function assertOAuthKvBound(root: string): void {
  const configPath = resolve(root, 'wrangler.jsonc')
  if (!existsSync(configPath)) {
    return
  }

  let config: Record<string, unknown>
  try {
    config = parseJsonc(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    return
  }

  const bound = oauthKvBinding(config)
  if (bound) {
    // Present, but still carrying the placeholder id this build scaffolds, which
    // `wrangler deploy` rejects. Warned rather than failed: the id is not needed
    // to *build*, and a --dry-run deploy on an unfinished config is reasonable.
    if (bound.id === oauthKvNamespace().id) {
      console.warn(
        `Cloudflare build: ${configPath} still has the scaffolded placeholder id for the ${OAUTH_KV_BINDING} binding, so a real deploy will be rejected. Create the namespace and paste its id in:\n`
        + `  wrangler kv namespace create ${OAUTH_KV_BINDING}`,
      )
    }
    return
  }

  throw new Error(
    `Cloudflare build: --mcp-oauth needs a KV namespace bound as ${OAUTH_KV_BINDING} — the OAuth provider stores its clients, grants and tokens there — and ${configPath} has none. Create one and add this entry, alongside whatever the file already has:\n`
    + `  "kv_namespaces": [\n`
    + `    ${JSON.stringify(oauthKvNamespace(), null, 2).split('\n').join('\n    ')}\n`
    + `  ]\n`
    + `Get the id from: wrangler kv namespace create ${OAUTH_KV_BINDING}`,
  )
}

/**
 * The KV namespace a parsed config binds under the provider's name, or
 * `undefined`. Returns the entry rather than a boolean because callers ask both
 * "is it bound" and "is its id still the placeholder" of the same match.
 */
function oauthKvBinding(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const namespaces = config.kv_namespaces
  if (!Array.isArray(namespaces)) {
    return undefined
  }

  return namespaces.find(
    (entry) =>
      typeof entry === 'object'
      && entry !== null
      && (entry as Record<string, unknown>).binding === OAUTH_KV_BINDING,
  ) as Record<string, unknown> | undefined
}

/** The binding entry, spelled once — the scaffold writes it, the guard quotes it. */
function oauthKvNamespace(): Record<string, string> {
  return { binding: OAUTH_KV_BINDING, id: `TODO: wrangler kv namespace create ${OAUTH_KV_BINDING}` }
}

/**
 * Whether the app declares `name` under `dependencies`. Same answer-shape as
 * `appUsesMcpPlugin` in `@guren/core/internal/deploy-build`: an absent,
 * unreadable or malformed manifest answers `false`.
 */
function appDependsOn(root: string, name: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const dependencies = manifest.dependencies
    return typeof dependencies === 'object' && dependencies !== null && name in dependencies
  } catch {
    return false
  }
}

/**
 * Both lists: on Workers the SQL clients are as unreachable as the dev-only
 * modules, because D1 is the only database the platform has.
 */
const STUBBED_MODULES = [...DEV_ONLY_MODULES, ...SQL_CLIENT_MODULES]

/**
 * Why the stubbed modules cannot run here, worded for this platform: each
 * names the Workers-appropriate replacement.
 */
const UNAVAILABLE_ON_WORKERS: Record<(typeof STUBBED_MODULES)[number]['kind'], string> = {
  sqlite: 'bun:sqlite is unavailable on Cloudflare Workers — use createD1Database().',
  vite: 'The Vite dev server is unavailable on Cloudflare Workers — assets are served by Workers Static Assets.',
  mcp: MCP_UNAVAILABLE,
  'sql-driver':
    'This database client is unavailable on Cloudflare Workers — use createD1Database(). '
    + 'It is stubbed because @guren/orm names it in a dynamic import that bundlers follow '
    + 'even when the branch cannot be taken.',
}

/**
 * Wrangler resolves an `alias` to a path on disk, so each stub needs a file of
 * its own. The names are hand-written rather than derived: they are baked into
 * every app's committed `wrangler.jsonc`, which the scaffold never overwrites.
 * Keyed on `DevOnlySpecifier`, so a new `DEV_ONLY_MODULES` entry is a compile
 * error here until it gets a filename.
 */
const STUB_FILES: Record<DevOnlySpecifier | SqlClientSpecifier, string> = {
  'bun:sqlite': 'stub-bun-sqlite.js',
  vite: 'stub-vite.js',
  '@guren/cli': 'stub-guren-cli.js',
  '@modelcontextprotocol/sdk/server/mcp.js': 'stub-mcp-server.js',
  '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js': 'stub-mcp-transport.js',
  postgres: 'stub-postgres.js',
  mysql2: 'stub-mysql2.js',
  'mysql2/promise': 'stub-mysql2-promise.js',
  '@aws-sdk/client-rds-data': 'stub-rds-data.js',
}

function writeDevOnlyStubs(out: string): void {
  for (const module of STUBBED_MODULES) {
    writeFileSync(
      resolve(out, STUB_FILES[module.specifier]),
      renderDevOnlyStub(module, UNAVAILABLE_ON_WORKERS[module.kind]),
    )
  }
}

/**
 * A package-name alias does not cover subpaths and wrangler cannot match a
 * prefix, so every stubbed specifier needs its own entry — an SDK subpath added
 * upstream needs a new `DEV_ONLY_MODULES` entry to stay stubbed.
 *
 * `mcpPlugin` drops the App MCP transport's entry (RFC 0016 §7): the adapter is
 * workerd-compatible, and the alias was the only thing killing it. The Dev MCP's
 * `McpServer` keeps its alias either way. The *files* are written unconditionally
 * by `writeDevOnlyStubs`, so a config still pointing at one keeps finding it.
 */
function devOnlyAliases(outRelative: string, mcpPlugin: boolean): Record<string, string> {
  const stubbed = [...stubbableDevOnlyModules({ mcpPlugin }), ...SQL_CLIENT_MODULES]

  return Object.fromEntries(
    stubbed.map((module) => [
      module.specifier,
      `./${outRelative}/${STUB_FILES[module.specifier]}`,
    ]),
  )
}

/**
 * Fail rather than deploy an app that declares `@guren/plugin-mcp` while its
 * committed `wrangler.jsonc` still aliases the App MCP transport to a stub *this
 * build generated* — the endpoint stays compiled shut with every gate green.
 *
 * The *value* decides, not the key: an alias naming anything else is a deliberate
 * override. Matched on the last path segment (the output directory is an option)
 * against `STUB_FILES`, splitting on both separators for hand-edited configs; a
 * developer shim named `stub-mcp-transport.js` is the one false positive left.
 * Read through `parseJsonc`, so a comment mentioning the specifier does not fail
 * the build; an unparseable file is left to `warnMissingBuildOwnedKeys`.
 */
function assertMcpTransportNotAliased(root: string, mcpPlugin: boolean): void {
  const configPath = resolve(root, 'wrangler.jsonc')
  if (!mcpPlugin || !existsSync(configPath)) {
    return
  }

  let config: Record<string, unknown>
  try {
    config = parseJsonc(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    return
  }

  const alias = config.alias
  if (typeof alias !== 'object' || alias === null) {
    return
  }

  const target = (alias as Record<string, unknown>)[MCP_TRANSPORT_SPECIFIER]
  if (typeof target !== 'string' || target.split(/[\\/]/).pop() !== STUB_FILES[MCP_TRANSPORT_SPECIFIER]) {
    return
  }

  throw new Error(
    `Cloudflare build: ${configPath} aliases the App MCP transport to a stub, but this app depends on ${MCP_PLUGIN_PACKAGE} — the endpoint would deploy compiled shut. Delete this one line from "alias":\n`
    + `  ${JSON.stringify(MCP_TRANSPORT_SPECIFIER)}: ${JSON.stringify(target)}\n`
    + `Leave every other alias entry in place; ${JSON.stringify('@modelcontextprotocol/sdk/server/mcp.js')} in particular must stay stubbed — that is the dev-only MCP server, which generates files on disk.`,
  )
}

/**
 * Wrangler's `migrations_dir` only discovers flat `*.sql` files, but
 * drizzle-kit (1.x) emits one `<timestamp>_<name>/migration.sql` folder per
 * migration. Flatten each folder into `<folder-name>.sql` (plain `*.sql`
 * files pass through unchanged, `meta/` bookkeeping is skipped) so
 * `wrangler d1 migrations apply` sees them in filename order. Regenerated on
 * every build — run `cloudflare:build` after adding a migration.
 */
export function flattenD1Migrations(migrationsDir: string, outDir: string): void {
  if (!existsSync(migrationsDir)) {
    return
  }

  const entries = readdirSync(migrationsDir, { withFileTypes: true })
  const copies: Array<{ from: string; to: string }> = []

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.sql')) {
      copies.push({ from: resolve(migrationsDir, entry.name), to: entry.name })
      continue
    }
    if (entry.isDirectory() && entry.name !== 'meta') {
      const nested = resolve(migrationsDir, entry.name, 'migration.sql')
      if (existsSync(nested)) {
        copies.push({ from: nested, to: `${entry.name}.sql` })
      }
    }
  }

  const seen = new Map<string, string>()
  for (const copy of copies) {
    const clash = seen.get(copy.to)
    if (clash) {
      throw new Error(
        `Cloudflare build: migrations "${clash}" and "${copy.from}" both flatten to "${copy.to}". Rename one so wrangler sees a stable order.`,
      )
    }
    seen.set(copy.to, copy.from)
  }

  // Rebuilt from scratch: a migration deleted or renamed upstream must not
  // linger here, because wrangler would still discover and apply it.
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true })
  }

  if (copies.length === 0) {
    return
  }

  mkdirSync(outDir, { recursive: true })
  for (const copy of copies) {
    cpSync(copy.from, resolve(outDir, copy.to))
  }
}

/**
 * Neutralize the document types staged under `assets/` with a `_headers` file.
 * Static Assets answer before the worker runs, so the framework's
 * `guardStaticDocument` never sees one and an SVG would render inline, script and
 * all, on the app's own origin. That `_headers` does not reach worker-generated
 * responses is right, not a limitation: those go through the framework guard.
 *
 * One splat per pattern: /*.svg is anchored and its splat greedy across slashes,
 * so it matches at any depth, while a second splat is a parse error the platform
 * reports by *dropping the rule*.
 */
function renderAssetHeaders(assetsOut: string): string {
  const headerLines = Object.entries(DOCUMENT_ASSET_HEADERS).map(([name, value]) => `  ${name}: ${value}`)
  const patterns = [
    ...DOCUMENT_ASSET_EXTENSIONS.map((extension) => `/*.${extension}`),
    ...oddlyCasedDocumentPaths(assetsOut),
  ]

  return [
    '# Generated by `guren cloudflare:build`. Do not edit — regenerate instead.',
    ...patterns.flatMap((pattern) => ['', pattern, ...headerLines]),
    '',
  ].join('\n')
}

/**
 * Staged document files whose extension is not already lowercase, as exact
 * patterns: the one hole the `/*.<ext>` globs cannot reach. `getMimeType`
 * lowercases before its lookup while Cloudflare compiles a `_headers` pattern
 * case-sensitively with no flag to say otherwise (measured against the asset
 * worker), and enumerating the variants is impossible at one splat per rule —
 * `.svg` alone has eight spellings. An exact rule is complete because the asset
 * set is closed at build time; the normal result is an empty list.
 */
function oddlyCasedDocumentPaths(assetsOut: string): string[] {
  const documents = new Set<string>(DOCUMENT_ASSET_EXTENSIONS)
  const paths: string[] = []

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(resolve(dir, entry.name), `${prefix}/${entry.name}`)
        continue
      }

      const dot = entry.name.lastIndexOf('.')
      const extension = dot === -1 ? '' : entry.name.slice(dot + 1)
      if (extension && extension !== extension.toLowerCase() && documents.has(extension.toLowerCase())) {
        paths.push(`${prefix}/${entry.name}`)
      }
    }
  }

  walk(assetsOut, '')

  return paths.sort()
}

/**
 * An app may ship a `_headers` of its own under `public/`, already copied here by
 * `stageStaticAssets`. Prepend rather than overwrite or append: only the *first*
 * rule naming a header sets it and a later one appends, so going second would
 * turn an app's own `Content-Disposition` into "inline, attachment".
 *
 * The cost: the platform parses at most 100 rules and *stops* at the hundredth,
 * so these five push an app's own five closer to that cap. Warned about rather
 * than resolved, since reordering would break the set-versus-append reasoning.
 */
function writeAssetHeaders(assetsOut: string): void {
  const headersFile = resolve(assetsOut, '_headers')

  // The read is the existence test: a wrong "absent" from a separate `existsSync`
  // would silently overwrite the app's own rules. `readFileSync` reports absence
  // itself, as ENOENT.
  let existing = ''
  try {
    existing = readFileSync(headersFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const generated = renderAssetHeaders(assetsOut)
  const merged = existing ? `${generated}\n${existing}` : generated

  warnHeaderRuleBudget(merged, existing)
  writeFileSync(headersFile, merged)
}

/** What the platform parses before it stops. */
const HEADER_RULE_LIMIT = 100

/**
 * Say so when the rules added here push an app's own past what the platform
 * reads. Cloudflare parses at most 100 rules and *stops* at the hundredth
 * silently, so going first — which the set-versus-append reasoning above
 * requires — drops the app's last rules. Counted rather than resolved: ordering
 * the app's rules first would let its `Content-Disposition` turn ours into
 * "inline, attachment".
 */
function warnHeaderRuleBudget(merged: string, existing: string): void {
  if (!existing) {
    return
  }

  const rules = merged.split('\n').filter((line) => line.startsWith('/')).length
  if (rules <= HEADER_RULE_LIMIT) {
    return
  }

  console.warn(
    `Cloudflare build: the merged _headers has ${rules} rules and the platform reads only ${HEADER_RULE_LIMIT}, `
    + `so the last ${rules - HEADER_RULE_LIMIT} of your app's own rules are dropped without an error. `
    + 'The generated document rules are placed first deliberately — the platform lets a later rule only append to a '
    + "header an earlier one set, so going second would turn your own Content-Disposition into \"inline, attachment\". "
    + 'Trim public/_headers to fit.',
  )
}

function readPackageJson(root: string): PackageJsonLike {
  const packageJsonPath = resolve(root, 'package.json')
  if (!existsSync(packageJsonPath)) {
    return {}
  }

  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJsonLike
  } catch {
    return {}
  }
}

function runAppBuild(root: string, scripts: Record<string, string>): void {
  if (!scripts.build) {
    throw new Error(
      'Cloudflare build: no "build" script found in package.json. Add one (codegen + vite build + vite build --ssr) or pass --skip-app-build after building manually.',
    )
  }

  const result = Bun.spawnSync({
    cmd: ['bun', 'run', 'build'],
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (result.exitCode !== 0) {
    throw new Error('Cloudflare build: the app "build" script failed.')
  }
}

interface SsrImport {
  /** Absolute path of the built SSR entry chunk. */
  file: string
  /** Export name the chunk exposes the renderer under; the worker names it directly. */
  rendererExport: 'render' | 'default'
}

async function resolveSsrImport(ssrDir: string, ssrEntryKey: string): Promise<SsrImport | undefined> {
  const file = resolveSsrEntryFile(ssrDir, ssrEntryKey, 'Cloudflare build')
  if (!file) {
    console.warn(
      `Cloudflare build: no SSR manifest entry for "${ssrEntryKey}" under ${ssrDir}; generating a CSR-only worker.`,
    )
    return undefined
  }

  const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  // Mirrors extractSsrRenderer in @guren/server (mvc/inertia/InertiaEngine.ts):
  // same order, same per-candidate function test. A copy rather than an import,
  // so build.ts keeps depending on node builtins alone.
  const rendererExport = (['render', 'default'] as const).find(
    (name) => typeof module[name] === 'function',
  )
  if (!rendererExport) {
    throw new Error(
      `Cloudflare build: SSR entry ${file} does not export a renderer (expected a named "render" or default export).`,
    )
  }

  return { file, rendererExport }
}

/**
 * Statements assigning the build-derived environment, emitted as their own module
 * because worker.js imports it *first*, the only ordering ESM import hoisting
 * cannot defeat. A statement in the worker body runs after the app's module graph
 * evaluated, so a module-scope `viteAsset()` call would see no manifest and throw
 * before the worker could start.
 */
function renderWorkerEnvModule(input: {
  assetEnv: ClientAssetEnv
  viteManifest: string | undefined
}): string | undefined {
  const lines: string[] = []

  if (input.assetEnv.entry) {
    lines.push(`process.env.GUREN_INERTIA_ENTRY = ${JSON.stringify(input.assetEnv.entry)}`)
  }
  if (input.assetEnv.styles) {
    lines.push(`process.env.GUREN_INERTIA_STYLES = ${JSON.stringify(input.assetEnv.styles)}`)
  }
  if (input.viteManifest) {
    // viteAsset() reads the client manifest at render time and Workers has no
    // filesystem, so the manifest JSON travels in the worker itself.
    lines.push(`process.env.GUREN_VITE_MANIFEST = ${JSON.stringify(input.viteManifest)}`)
  }

  if (lines.length === 0) {
    return undefined
  }

  return [
    '// Generated by `guren cloudflare:build`. Do not edit — regenerate instead.',
    ...lines,
    '',
  ].join('\n')
}

function renderWorkerModule(input: {
  out: string
  appEntry: string
  ssrImport: SsrImport | undefined
  hasEnvModule: boolean
  mcpOAuth: boolean
  mcpPath: string
}): string {
  const lines: string[] = [
    '// Generated by `guren cloudflare:build`. Do not edit — regenerate instead.',
  ]

  if (input.hasEnvModule) {
    // Must stay the first import — see renderWorkerEnvModule.
    lines.push("import './worker-env.js'")
  }

  lines.push("import { createWorkersHandler } from '@guren/plugin-cloudflare'")

  if (input.mcpOAuth) {
    lines.push(
      `import { OAuthProvider } from ${JSON.stringify(OAUTH_PROVIDER_PACKAGE)}`,
      `import { mcpOAuthPropsToAuth, presentExternalMcpAuth } from ${JSON.stringify(MCP_OAUTH_SEAM_SPECIFIER)}`,
    )
  }

  if (input.ssrImport) {
    lines.push(
      "import { setInertiaSsrRenderer } from '@guren/core'",
      `import * as ssrModule from ${JSON.stringify(importSpecifier(input.out, input.ssrImport.file, 'Cloudflare build'))}`,
    )
  }

  lines.push(`import app from ${JSON.stringify(importSpecifier(input.out, input.appEntry, 'Cloudflare build'))}`, '')

  if (input.ssrImport) {
    lines.push(`setInertiaSsrRenderer(ssrModule.${input.ssrImport.rendererExport})`, '')
  }

  if (!input.mcpOAuth) {
    lines.push('export default createWorkersHandler(app)', '')
    return lines.join('\n')
  }

  lines.push(renderOAuthWorker(input.mcpPath), '')

  return lines.join('\n')
}

/**
 * wrangler resolves its config as `wrangler.json` ?? `wrangler.jsonc` ??
 * `wrangler.toml`, first match winning silently (workers-sdk config-helpers.ts).
 * This plugin manages `wrangler.jsonc`, so a `wrangler.json` outranks everything
 * the build scaffolds or checks, and scaffolding beside a lone `wrangler.toml`
 * makes wrangler stop reading the user's own config. Neither can be repaired
 * here: name the migration and stop before the app build spends minutes on it.
 */
function assertWranglerJsoncIsAuthoritative(root: string): void {
  if (wranglerConfigExists(resolve(root, 'wrangler.json'))) {
    throw new Error(
      'Cloudflare build: found wrangler.json. wrangler reads it before the wrangler.jsonc this plugin manages, so the build-owned keys would never reach a deploy. Rename it to wrangler.jsonc — every JSON file is already valid JSONC.',
    )
  }

  if (!wranglerConfigExists(resolve(root, 'wrangler.toml'))) {
    return
  }

  if (wranglerConfigExists(resolve(root, 'wrangler.jsonc'))) {
    console.warn(
      'Cloudflare build: wrangler.toml is dead weight — wrangler reads wrangler.jsonc first. Port anything still missing into wrangler.jsonc, then delete wrangler.toml so edits to it stop looking like configuration.',
    )
    return
  }

  throw new Error(
    'Cloudflare build: found wrangler.toml, but this plugin manages wrangler.jsonc — it cannot read TOML to check the build-owned keys, and scaffolding wrangler.jsonc beside it would make wrangler silently ignore wrangler.toml. Move wrangler.toml aside, rerun the build to scaffold a reference wrangler.jsonc, then port your settings into it.',
  )
}

/**
 * `existsSync` folds an unreadable entry into "absent", and absent is the
 * branch that scaffolds a config file beside it — only ENOENT may mean no.
 */
function wranglerConfigExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

/**
 * Serve a staged `.html` file at its own path and nowhere else.
 *
 * The platform default, `auto-trailing-slash`, serves `public/page.html` at
 * `/page` and *redirects* `/page.html` there (measured against the asset worker).
 * That would leave the /*.html rule in `_headers` landing only on the redirect,
 * and let a file under `public/` shadow the app's own route of that name, since
 * assets answer before the worker. A miss now falls through to the worker.
 */
const HTML_HANDLING = 'none'

/**
 * The OAuth-fronted export: one `createWorkersHandler` threaded through both
 * halves of the provider (two would share the module-global env holder without
 * sharing the boot slot — see `handler.ts`).
 *
 * The grant travels through the seam, not a header: `ctx.props` is what the
 * provider decrypted from the access token it validated, so a caller reaching the
 * app another way cannot forge it. `defaultHandler` is the same handler unwrapped,
 * so every non-MCP route is served as it would be without the provider.
 */
function renderOAuthWorker(mcpPath: string): string {
  // A template literal rather than a line array, so a reviewer can read the
  // generated program as one.
  return `// One handler for both halves of the provider: it dedupes boot() per
// handler while the Workers env holder is module-global, so a second one
// would share the holder without sharing the boot slot.
const handler = createWorkersHandler(app)

export default new OAuthProvider({
  apiRoute: ${JSON.stringify(mcpPath)},
  apiHandler: {
    fetch(request, env, ctx) {
      // ctx.props is the grant the provider decrypted from the access
      // token it has already validated. A shape the endpoint cannot read
      // is refused here, never forwarded as a partial principal.
      const auth = mcpOAuthPropsToAuth(ctx.props)
      if (!auth) {
        return new Response(
          JSON.stringify({
            error: 'unauthorized',
            message: 'This access token carries no readable grant. Re-authorize the client.',
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        )
      }
      // The seam is keyed on this exact Request object — dispatch the one
      // presentExternalMcpAuth returns, never a copy of it.
      return handler.fetch(presentExternalMcpAuth(request, auth), env, ctx)
    },
  },
  defaultHandler: handler,
  authorizeEndpoint: ${JSON.stringify(OAUTH_ENDPOINTS.authorize)},
  tokenEndpoint: ${JSON.stringify(OAUTH_ENDPOINTS.token)},
  // Dynamic client registration (RFC 7591). Deprecated in the MCP
  // 2026-07-28 line in favour of Client ID Metadata Documents, but it is
  // what shipping MCP SDK 1.x clients use to register themselves today.
  clientRegistrationEndpoint: ${JSON.stringify(OAUTH_ENDPOINTS.register)},
})`
}

function scaffoldWranglerConfig(
  root: string,
  out: string,
  packageName: string | undefined,
  mcpPlugin: boolean,
  mcpOAuth: boolean,
): void {
  const configPath = resolve(root, 'wrangler.jsonc')
  const appName = (packageName ?? 'guren-app').replace(/^@[^/]+\//, '')
  const outRelative = relative(root, out).split(sep).join('/')

  const config = {
    name: appName,
    main: `${outRelative}/worker.js`,
    compatibility_date: new Date().toISOString().slice(0, 10),
    compatibility_flags: ['nodejs_compat'],
    alias: devOnlyAliases(outRelative, mcpPlugin),
    define: {
      // Framework and app code branch on NODE_ENV at module scope, statements in
      // the generated worker cannot beat ESM import hoisting, and wrangler `vars`
      // are not guaranteed to reach `process.env` before the module graph
      // evaluates — so it is substituted at build time.
      'process.env.NODE_ENV': '"production"',
      // workerd leaves `import.meta.url` undefined, which kills Vite's SSR
      // `createRequire(import.meta.url)` and scaffolded `new URL(..., import.meta.url)`
      // at module scope. A literal is safe because Workers has no filesystem, so
      // every such path is meaningless there anyway.
      'import.meta.url': '"file:///worker.js"',
    },
    assets: { directory: `${outRelative}/assets`, html_handling: HTML_HANDLING },
    d1_databases: [
      {
        binding: 'DB',
        database_name: appName,
        database_id: 'TODO: wrangler d1 create',
        migrations_dir: `${outRelative}/d1-migrations`,
      },
    ],
    // Build-owned only while --mcp-oauth is on: an app that never fronts the
    // MCP endpoint with OAuth has nothing to store in this namespace, and a
    // binding scaffolded "just in case" is a namespace someone has to create
    // before the config validates.
    ...(mcpOAuth ? { kv_namespaces: [oauthKvNamespace()] } : {}),
    vars: { NODE_ENV: 'production' },
  }

  try {
    // `wx` is the exists-check and the write in one atomic operation; an
    // existing config is never overwritten.
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      warnMissingBuildOwnedKeys(configPath, outRelative, mcpPlugin, mcpOAuth)
      return
    }
    throw error
  }
  const notes = ['fill in d1_databases[0].database_id']
  if (mcpOAuth) {
    notes.push(`create the ${OAUTH_KV_BINDING} namespace (wrangler kv namespace create ${OAUTH_KV_BINDING}) and fill in its id`)
  }
  console.log(`Cloudflare build: scaffolded ${configPath} — ${notes.join(', and ')} before deploying.`)
}

/**
 * The consent flow, written once into the app and never overwritten, on the same
 * contract as `wrangler.jsonc`: these are the developer's files from the moment
 * they exist. Only reached with `--mcp-oauth` on.
 */
function scaffoldConsentFlow(root: string): void {
  const written: string[] = []

  for (const path of MCP_OAUTH_TEMPLATE_FILES) {
    const target = resolve(root, ...path.split('/'))
    mkdirSync(resolve(target, '..'), { recursive: true })
    try {
      writeFileSync(target, loadMcpOAuthTemplate(path), { flag: 'wx' })
      written.push(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
  }

  if (written.length === 0) {
    return
  }

  console.log(
    `Cloudflare build: scaffolded the OAuth consent flow — ${written.join(', ')}.`,
  )

  if (written.includes(MCP_OAUTH_ROUTES_FILE)) {
    // Said only on the build that created the file, the one moment nothing can
    // have wired it yet. Answering it later would mean a second implementation of
    // `@guren/cli`'s route-registrar rule, which would drift from `guren check`.
    console.log(
      `  Nothing mounts ${MCP_OAUTH_ROUTES_FILE} yet. Add these two lines to your routes entry (routes/web.ts):\n`
      + `    import { ${MCP_OAUTH_REGISTRAR} } from './mcp-oauth'\n`
      + `    ${MCP_OAUTH_REGISTRAR}(router)   // inside your registrar, with its router parameter`,
    )
  }
}

/**
 * `wrangler.jsonc` carries comments in any app that has edited it, and
 * `JSON.parse` rejects the first one.
 *
 * Only comments and trailing commas are stripped, the whole of what wrangler
 * accepts beyond JSON. The scan tracks string literals rather than pattern-
 * matching, because `define` holds `"\"file:///worker.js\""` — a `//` inside a
 * string, with escaped quotes around it.
 */
function parseJsonc(text: string): unknown {
  const out: string[] = []
  let index = 0

  while (index < text.length) {
    const char = text[index]

    if (char === '"') {
      const start = index
      index += 1
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2
          continue
        }
        if (text[index] === '"') {
          index += 1
          break
        }
        index += 1
      }
      out.push(text.slice(start, index))
      continue
    }

    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') {
        index += 1
      }
      continue
    }

    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
      continue
    }

    if (char === '}' || char === ']') {
      // Every chunk is one character except a string literal, emitted whole and
      // never blank or a bare comma — so a comma as the last non-blank chunk is
      // a trailing one, not a comma inside a value.
      let back = out.length - 1
      while (back >= 0 && /^\s+$/.test(out[back])) {
        back -= 1
      }
      if (back >= 0 && out[back] === ',') {
        out.splice(back, 1)
      }
    }

    out.push(char)
    index += 1
  }

  return JSON.parse(out.join(''))
}

/**
 * The scaffold never overwrites an existing config, but `alias`, `define` and
 * `migrations_dir` are build-owned invariants pointing into the output directory:
 * an app scaffolded before they existed deploys a worker that cannot resolve
 * `bun:sqlite` or never applies its migrations. Name what is missing rather than
 * failing the build.
 *
 * Individual entries, never a whole `"alias"` or `"define"` object: apps keep
 * their own entries under both keys, and a complete object reads as one to paste
 * over what is there.
 */
function warnMissingBuildOwnedKeys(
  configPath: string,
  outRelative: string,
  mcpPlugin: boolean,
  mcpOAuth: boolean,
): void {
  let config: Record<string, unknown>
  try {
    config = parseJsonc(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    // Past the comment and trailing-comma stripping, so the file is malformed by
    // wrangler's reckoning too; passing silently leaves the keys below unchecked.
    console.warn(
      `Cloudflare build: could not parse ${configPath}, so its build-owned keys went unchecked. Fix the file, or compare it against a config scaffolded in an empty directory.`,
    )
    return
  }

  const missing: string[] = []
  // A non-object `alias` is malformed rather than outdated, and `in` would throw
  // out of a function whose point is to warn. Treat it as holding no entries.
  const configAlias = config.alias
  const alias = (
    typeof configAlias === 'object' && configAlias !== null ? configAlias : {}
  ) as Record<string, string>
  for (const [specifier, target] of Object.entries(devOnlyAliases(outRelative, mcpPlugin))) {
    if (!(specifier in alias)) {
      missing.push(`${JSON.stringify(specifier)}: ${JSON.stringify(target)} (inside "alias")`)
    }
  }
  const define = config.define as Record<string, string> | undefined
  if (!define?.['process.env.NODE_ENV']) {
    missing.push('"process.env.NODE_ENV": "\\"production\\"" (inside "define")')
  }
  const d1 = (config.d1_databases as Array<Record<string, unknown>> | undefined)?.[0]
  if (d1 && d1.migrations_dir !== `${outRelative}/d1-migrations`) {
    missing.push(`"migrations_dir": "${outRelative}/d1-migrations" (inside d1_databases[0])`)
  }

  if (missing.length > 0) {
    console.warn(
      `Cloudflare build: ${configPath} predates this plugin version. Add these entries, alongside whatever the file already has under the same keys, or the worker will fail to start or skip migrations:\n  ${missing.join('\n  ')}`,
    )
  }

  warnMissingHtmlHandling(configPath, config)
  warnOAuthDrift(configPath, config, mcpOAuth)
}

/**
 * Kept out of `warnMissingBuildOwnedKeys`: that list's shared sentence ends "the
 * worker will fail to start or skip migrations", which is not true here — adding
 * this key *changes* how the app's own HTML is served, and needs saying.
 *
 * Warned only when the key is absent: any other value is a decision an app typed,
 * and a config with no `assets` serves no static files for `_headers` to protect.
 */
function warnMissingHtmlHandling(configPath: string, config: Record<string, unknown>): void {
  const assets = config.assets as Record<string, unknown> | undefined

  if (!assets || assets.html_handling !== undefined) {
    return
  }

  console.warn(
    `Cloudflare build: ${configPath} does not set "html_handling" under "assets", so a document staged from public/ is still served at its extensionless path — where the /*.html rule in _headers does not reach it, and where it shadows any route of that name in your app. Add "html_handling": "${HTML_HANDLING}" to close both. Note this changes how those files are served: public/about.html stops answering at /about.`,
  )
}

/**
 * The drift `--mcp-oauth` leaves detectable in the other direction: a config
 * scaffolded *with* the flag (carrying `OAUTH_KV`) while today's build omitted
 * it. The replacing worker has no `OAuthProvider`, `/oauth/token` and
 * `/oauth/register` answer 404, and every authorized client stops working with
 * nothing in the build output mentioning OAuth.
 *
 * A warning, not a failure: building a non-OAuth worker from the same repository
 * is legitimate and the binding is inert either way.
 */
function warnOAuthDrift(
  configPath: string,
  config: Record<string, unknown>,
  mcpOAuth: boolean,
): void {
  if (mcpOAuth || !oauthKvBinding(config)) {
    return
  }

  console.warn(
    `Cloudflare build: ${configPath} binds ${OAUTH_KV_BINDING}, which only an OAuth-fronted worker uses, but this build ran without --mcp-oauth. The worker it produced has no OAuth provider in it: ${OAUTH_ENDPOINTS.token} and ${OAUTH_ENDPOINTS.register} will 404 and already-authorized clients will stop working. Pass --mcp-oauth, or remove the binding if this app no longer fronts its MCP endpoint with OAuth.`,
  )
}


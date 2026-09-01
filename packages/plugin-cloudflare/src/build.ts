import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  const packageJson = readPackageJson(root)
  // The App MCP opt-in is decided once and threaded to both halves of the
  // decision below — the guard on the committed config, and the alias set the
  // scaffold writes. Deciding it twice would be two places for one answer to
  // disagree, silently; the other two deploy plugins thread it the same way.
  // This does parse package.json a second time, after `readPackageJson` above
  // answered a different question (scripts, name): a second parse is cheap and
  // cannot disagree with anything, a second *decision* is neither.
  const mcpPlugin = appUsesMcpPlugin(root)

  // Checked here, before the app build: this is a one-line edit to a file the
  // developer owns, and reporting it after several minutes of Vite output is
  // reporting it where nobody reads.
  assertMcpTransportNotAliased(root, mcpPlugin)

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
    renderWorkerModule({ out, appEntry, ssrImport, hasEnvModule: workerEnv !== undefined }),
  )

  flattenD1Migrations(resolve(root, 'db/migrations'), resolve(out, 'd1-migrations'))

  writeDevOnlyStubs(out)

  scaffoldWranglerConfig(root, out, packageJson.name, mcpPlugin)
}

const MCP_UNAVAILABLE = 'The MCP endpoint is unavailable on Cloudflare Workers — it generates files on disk.'

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
 * Wrangler resolves an `alias` to a path on disk, so unlike a bundler plugin
 * each stub needs a file of its own. The names are deliberately hand-written
 * rather than derived: they are baked into every app's committed
 * `wrangler.jsonc`, which the scaffold never overwrites, so deriving them
 * would rename files out from under existing apps for no benefit.
 *
 * Keyed on `DevOnlySpecifier`, so adding an entry to `DEV_ONLY_MODULES` is a
 * compile error here until it gets a filename — the drift a derived name would
 * have prevented, caught by the type system instead.
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
 * A package-name alias does not cover subpaths, so every stubbed specifier —
 * including each MCP SDK subpath — needs its own entry. Unlike the Lambda
 * plugin's bundler hook, wrangler cannot match a prefix, so an SDK subpath
 * added upstream needs a new `DEV_ONLY_MODULES` entry to stay stubbed here.
 *
 * `mcpPlugin` drops the App MCP transport's entry (RFC 0016 §7): an app that
 * declares `@guren/plugin-mcp` serves the endpoint from the worker, and the
 * adapter is workerd-compatible by construction — the alias was the only
 * thing killing it. The Dev MCP's `McpServer` keeps its alias either way.
 *
 * The *files* are written unconditionally by `writeDevOnlyStubs`; only the
 * alias set varies. A stub file costs nothing, and an app whose committed
 * `wrangler.jsonc` still points at one must keep finding it.
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
 * Fail rather than deploy an app whose committed `wrangler.jsonc` still points
 * the App MCP transport at a stub *this build generated*, while its manifest
 * declares `@guren/plugin-mcp`.
 *
 * The scaffold writes `wrangler.jsonc` once and never overwrites it, so an
 * app that adds the plugin later keeps an alias nothing in the build controls
 * — and the endpoint stays compiled shut with every gate green, the failure
 * appearing only as `tools/list` returning nothing against a deployed worker.
 * A warning would be the wrong instrument: this is one line to delete, in a
 * file the developer owns, and the build can name it exactly.
 *
 * The *value* is what decides, not the key. An alias on this specifier is only
 * build residue when it names the stub file this build writes; pointing it at
 * a shim of the developer's own is a deliberate override — an alternative
 * transport, an instrumented wrapper — and none of this build's business.
 * Failing on the key alone would refuse a config that has nothing wrong with
 * it, while asserting in the message that a stub is there when it is not.
 *
 * The test is on the last path segment, not on the whole path: the output
 * directory the alias points into is an option, so the same residue reads as
 * `./.cloudflare/…` in one app and `./dist/cf/…` in the next. The filename
 * comes from `STUB_FILES` rather than a re-spelled literal — it has exactly
 * one definition, and a rename there must not leave a second spelling behind
 * that silently stops matching. Both separators are split on: the value is a
 * specifier wrangler resolves, so it is written with forward slashes, but a
 * config hand-edited on Windows need not be. A developer shim that happens to
 * be named `stub-mcp-transport.js` would be misread, which is the one false
 * positive left and is a name this build generates.
 *
 * `mcpPlugin` arrives as an argument rather than being read here, so this and
 * the alias set the scaffold writes cannot end up disagreeing about the same
 * manifest.
 *
 * Read through `parseJsonc` rather than as text, for the same reason
 * `warnMissingBuildOwnedKeys` does: a config carries comments, and a comment
 * mentioning the specifier — including the one the failure message itself
 * suggests writing — must not fail the build. A file that does not parse is
 * left to that function's warning; failing a deploy on a file this build
 * could not read would be worse than the defect.
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
 * Neutralize the document types staged under `assets/` with a `_headers`
 * file, the platform's own mechanism for the job.
 *
 * Workers Static Assets answer a request for a staged file *before* the worker
 * runs, so `guardStaticDocument` — which the framework applies on every mount
 * that reaches `public/` — never sees one here. Without this the same app
 * downloads an SVG locally and renders it inline, script and all, on its own
 * origin in production.
 *
 * That `_headers` does not apply to worker-generated responses is what makes
 * it the right mechanism rather than a limitation of it: those responses
 * already go through the framework guard, and a rule reaching them would put
 * `attachment` on a dynamic /sitemap.xml.
 *
 * One splat per pattern, and the extension is the only literal part: /*.svg
 * compiles to an anchored regular expression whose splat is greedy across
 * slashes, so it matches at any depth, while a second splat in one rule is a
 * parse error the platform reports by *dropping the rule*.
 */
function renderAssetHeaders(): string {
  const headerLines = Object.entries(DOCUMENT_ASSET_HEADERS).map(([name, value]) => `  ${name}: ${value}`)

  return [
    '# Generated by `guren cloudflare:build`. Do not edit — regenerate instead.',
    ...DOCUMENT_ASSET_EXTENSIONS.flatMap((extension) => ['', `/*.${extension}`, ...headerLines]),
    '',
  ].join('\n')
}

/**
 * An app may ship a `_headers` of its own under `public/`, which
 * `stageStaticAssets` has already copied here. Prepend rather than overwrite,
 * and prepend rather than append: the platform applies every matching rule,
 * but only the *first* rule naming a header sets it — a later one appends to
 * the value it finds. Going second would turn an app's own
 * `Content-Disposition` into "inline, attachment"; going first leaves the
 * app's rules appending to ours, which is the harmless direction.
 *
 * The trade the direction costs: the platform parses at most 100 rules and
 * *stops* at the hundredth, so these five push an app's own rules five closer
 * to a cap past which the remainder is dropped rather than reported. Warned
 * about here rather than resolved, because reordering to spend the budget on
 * the app's rules first is the change that breaks the set-versus-append
 * reasoning above.
 */
function writeAssetHeaders(assetsOut: string): void {
  const headersFile = resolve(assetsOut, '_headers')
  const existing = existsSync(headersFile) ? readFileSync(headersFile, 'utf8') : ''

  writeFileSync(headersFile, existing ? `${renderAssetHeaders()}\n${existing}` : renderAssetHeaders())
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
  // same order, same per-candidate function test, so the build accepts exactly
  // what the server would run. Kept as a copy rather than an import — build.ts
  // otherwise depends on node builtins alone.
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
 * Statements assigning the build-derived environment, emitted as a module of
 * their own rather than as lines in worker.js: worker.js imports this module
 * *first*, which is the only ordering ESM import hoisting cannot defeat. A
 * statement in the worker body runs after the app's module graph has already
 * evaluated, so a module-scope `viteAsset()` call in the app would see no
 * manifest and throw before the worker could start. (The Lambda wrapper
 * solves the same hazard by assigning env before dynamically importing the
 * app.)
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
    // viteAsset() resolves content-page assets from the client manifest at
    // render time, and Workers has no filesystem to read it from — so the
    // manifest JSON travels in the worker itself.
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
}): string {
  const lines: string[] = [
    '// Generated by `guren cloudflare:build`. Do not edit — regenerate instead.',
  ]

  if (input.hasEnvModule) {
    // Must stay the first import — see renderWorkerEnvModule.
    lines.push("import './worker-env.js'")
  }

  lines.push("import { createWorkersHandler } from '@guren/plugin-cloudflare'")

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

  lines.push('export default createWorkersHandler(app)', '')

  return lines.join('\n')
}

/**
 * Serve a staged `.html` file at its own path and nowhere else.
 *
 * The platform default, `auto-trailing-slash`, serves `public/page.html` at
 * `/page` and *redirects* `/page.html` there — measured against the asset
 * worker, not assumed. Two consequences, and this setting is the only thing
 * that answers either: the /*.html rule in `_headers` would otherwise only
 * ever land on the redirect, leaving the document itself inline; and a file
 * under `public/` would shadow the app's own route of that name, because
 * assets answer before the worker does.
 *
 * A miss now falls through to the worker, which is where a Guren app's pages
 * come from in the first place.
 */
const HTML_HANDLING = 'none'

function scaffoldWranglerConfig(
  root: string,
  out: string,
  packageName: string | undefined,
  mcpPlugin: boolean,
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
      // Statements in the generated worker cannot beat ESM import hoisting,
      // and wrangler `vars` are not guaranteed to reach `process.env` before
      // the app's module graph evaluates — framework and app code branch on
      // NODE_ENV at module scope, so it is substituted at build time (the
      // same approach the Vercel plugin takes).
      'process.env.NODE_ENV': '"production"',
      // workerd leaves `import.meta.url` undefined. Two things break on it:
      // Vite's SSR bundle initializes `createRequire(import.meta.url)`, and
      // scaffolded config resolves paths with `new URL(..., import.meta.url)`
      // — both at module scope, so the worker dies before serving anything.
      // Substituting a literal is safe precisely because Workers has no
      // filesystem: every such path is already meaningless there.
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
    vars: { NODE_ENV: 'production' },
  }

  try {
    // `wx` is the exists-check and the write in one atomic operation; an
    // existing config is never overwritten.
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      warnMissingBuildOwnedKeys(configPath, outRelative, mcpPlugin)
      return
    }
    throw error
  }
  console.log(`Cloudflare build: scaffolded ${configPath} — fill in d1_databases[0].database_id before deploying.`)
}

/**
 * `wrangler.jsonc` is JSONC by name and by habit — the scaffold writes plain
 * JSON, but every app that has touched the file since has comments in it, and
 * `JSON.parse` rejects the first one. Reading it with `JSON.parse` meant the
 * upgrade warning below could not fire for the population it was written for.
 *
 * Only comments and trailing commas are stripped, which is the whole of what
 * wrangler accepts beyond JSON. The scan tracks string literals rather than
 * pattern-matching, because a config carries both hazards for real: `define`
 * holds `"\"file:///worker.js\""`, where the `//` is inside a string and the
 * quotes around it are escaped.
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
      // Every chunk is one character except a string literal, which is
      // emitted whole and can never be blank or a bare comma. So the last
      // non-blank chunk being a comma means a trailing one, not a comma
      // inside a value.
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
 * The scaffold never overwrites an existing config, but `alias`, `define`,
 * and `migrations_dir` are build-owned invariants pointing into the output
 * directory — an app scaffolded before they existed deploys a worker that
 * cannot resolve `bun:sqlite` or never applies its migrations. Name exactly
 * what is missing rather than failing the build.
 *
 * Individual entries, never a whole `"alias"` or `"define"` object: apps keep
 * their own entries under both keys — a `shiki` stub, a pinned `@guren/orm`,
 * an extra `define` — and a suggestion shaped like a complete object reads as
 * one to paste over what is there, which would drop them.
 */
function warnMissingBuildOwnedKeys(
  configPath: string,
  outRelative: string,
  mcpPlugin: boolean,
): void {
  let config: Record<string, unknown>
  try {
    config = parseJsonc(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    // Past the comment and trailing-comma stripping, so the file is malformed
    // by wrangler's reckoning too — say so rather than pass silently, because
    // the keys below going unchecked is how a deploy fails later instead.
    console.warn(
      `Cloudflare build: could not parse ${configPath}, so its build-owned keys went unchecked. Fix the file, or compare it against a config scaffolded in an empty directory.`,
    )
    return
  }

  const missing: string[] = []
  // A non-object `alias` is malformed rather than merely outdated, and `in`
  // would throw it out of a function whose whole point is to warn instead of
  // failing the build. Treat it as holding no entries and name them all.
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
}

/**
 * Kept out of `warnMissingBuildOwnedKeys` even though it fires beside it: the
 * entries there are invariants pointing into the output directory, and their
 * shared sentence ends "the worker will fail to start or skip migrations",
 * which is not true of this one. What is true of it is the opposite kind of
 * consequence — adding it *changes* how the app's own HTML is served — so it
 * needs a message that says that rather than a line in that list.
 *
 * Warned only when the key is absent. Naming any other value is a decision an
 * app had to type, and a config with no `assets` at all serves no static
 * files, so it has nothing for the rules in `_headers` to protect.
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


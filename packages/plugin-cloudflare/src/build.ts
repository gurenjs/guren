import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEV_ONLY_MODULES,
  importSpecifier,
  renderDevOnlyStub,
  assertOutputDirOutsideRoot,
  resetOutputDir,
  resolveClientAssetEnv,
  resolvePathLike,
  resolveSsrEntryFile,
  stageStaticAssets,
  type ClientAssetEnv,
  type DevOnlyModule,
  type DevOnlySpecifier,
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

  if (!options.skipAppBuild) {
    runAppBuild(root, packageJson.scripts ?? {})
  }

  if (!existsSync(appEntry)) {
    throw new Error(`Cloudflare build: app entry not found at ${appEntry}. Pass "appEntry" if your Application lives elsewhere.`)
  }

  const ssrImport = await resolveSsrImport(ssrDir, ssrEntryKey)
  const assetEnv = resolveClientAssetEnv(publicDir, clientEntryKey, 'Cloudflare build')

  resetOutputDir(out, root, 'Cloudflare build')

  // Workers Static Assets serves `/` from index.html BEFORE the worker runs,
  // and has no rewrites for the built assets' `/public/assets/` base — both
  // handled by the shared staging step.
  stageStaticAssets(publicDir, resolve(out, 'assets'))

  writeFileSync(resolve(out, 'worker.js'), renderWorkerModule({ out, appEntry, ssrImport, assetEnv }))

  flattenD1Migrations(resolve(root, 'db/migrations'), resolve(out, 'd1-migrations'))

  writeDevOnlyStubs(out)

  scaffoldWranglerConfig(root, out, packageJson.name)
}

const MCP_UNAVAILABLE = 'The MCP endpoint is unavailable on Cloudflare Workers — it generates files on disk.'

/**
 * Why the dev-only modules in `DEV_ONLY_MODULES` cannot run here, worded for
 * this platform: each names the Workers-appropriate replacement.
 */
const UNAVAILABLE_ON_WORKERS: Record<DevOnlyModule['kind'], string> = {
  sqlite: 'bun:sqlite is unavailable on Cloudflare Workers — use createD1Database().',
  vite: 'The Vite dev server is unavailable on Cloudflare Workers — assets are served by Workers Static Assets.',
  mcp: MCP_UNAVAILABLE,
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
const STUB_FILES: Record<DevOnlySpecifier, string> = {
  'bun:sqlite': 'stub-bun-sqlite.js',
  vite: 'stub-vite.js',
  '@guren/cli': 'stub-guren-cli.js',
  '@modelcontextprotocol/sdk/server/mcp.js': 'stub-mcp-server.js',
  '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js': 'stub-mcp-transport.js',
}

function writeDevOnlyStubs(out: string): void {
  for (const module of DEV_ONLY_MODULES) {
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
 */
function devOnlyAliases(outRelative: string): Record<string, string> {
  return Object.fromEntries(
    DEV_ONLY_MODULES.map((module) => [
      module.specifier,
      `./${outRelative}/${STUB_FILES[module.specifier]}`,
    ]),
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

function renderWorkerModule(input: {
  out: string
  appEntry: string
  ssrImport: SsrImport | undefined
  assetEnv: ClientAssetEnv
}): string {
  const lines: string[] = [
    '// Generated by `guren cloudflare:build`. Do not edit — regenerate instead.',
    "import { createWorkersHandler } from '@guren/plugin-cloudflare'",
  ]

  if (input.ssrImport) {
    lines.push(
      "import { setInertiaSsrRenderer } from '@guren/core'",
      `import * as ssrModule from ${JSON.stringify(importSpecifier(input.out, input.ssrImport.file, 'Cloudflare build'))}`,
    )
  }

  lines.push(`import app from ${JSON.stringify(importSpecifier(input.out, input.appEntry, 'Cloudflare build'))}`, '')

  if (input.assetEnv.entry) {
    lines.push(`process.env.GUREN_INERTIA_ENTRY = ${JSON.stringify(input.assetEnv.entry)}`)
  }
  if (input.assetEnv.styles) {
    lines.push(`process.env.GUREN_INERTIA_STYLES = ${JSON.stringify(input.assetEnv.styles)}`)
  }
  if (input.assetEnv.entry || input.assetEnv.styles) {
    lines.push('')
  }

  if (input.ssrImport) {
    lines.push(`setInertiaSsrRenderer(ssrModule.${input.ssrImport.rendererExport})`, '')
  }

  lines.push('export default createWorkersHandler(app)', '')

  return lines.join('\n')
}

function scaffoldWranglerConfig(root: string, out: string, packageName: string | undefined): void {
  const configPath = resolve(root, 'wrangler.jsonc')
  const appName = (packageName ?? 'guren-app').replace(/^@[^/]+\//, '')
  const outRelative = relative(root, out).split(sep).join('/')

  const config = {
    name: appName,
    main: `${outRelative}/worker.js`,
    compatibility_date: new Date().toISOString().slice(0, 10),
    compatibility_flags: ['nodejs_compat'],
    alias: devOnlyAliases(outRelative),
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
    assets: { directory: `${outRelative}/assets` },
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
      warnMissingBuildOwnedKeys(configPath, outRelative)
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
function warnMissingBuildOwnedKeys(configPath: string, outRelative: string): void {
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
  for (const [specifier, target] of Object.entries(devOnlyAliases(outRelative))) {
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
}


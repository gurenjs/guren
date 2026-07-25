import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type PathLike = string | URL

type ManifestEntry = {
  file?: string
  css?: string[]
}

type Manifest = Record<string, ManifestEntry>

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

  if (out === root || root.startsWith(out + sep)) {
    throw new Error(
      `Cloudflare build: outputDir (${out}) must be a directory outside or below the app root, never the root itself — it is deleted on every build.`,
    )
  }

  const packageJson = readPackageJson(root)

  if (!options.skipAppBuild) {
    runAppBuild(root, packageJson.scripts ?? {})
  }

  if (!existsSync(appEntry)) {
    throw new Error(`Cloudflare build: app entry not found at ${appEntry}. Pass "appEntry" if your Application lives elsewhere.`)
  }

  const ssrImport = await resolveSsrImport(ssrDir, ssrEntryKey)
  const assetEnv = resolveClientAssetEnv(root, clientEntryKey)

  if (existsSync(out)) {
    rmSync(out, { recursive: true, force: true })
  }
  mkdirSync(resolve(out, 'assets'), { recursive: true })

  if (existsSync(publicDir)) {
    cpSync(publicDir, resolve(out, 'assets'), { recursive: true })
  }

  // Workers Static Assets serves index.html for `/` BEFORE the worker runs,
  // which would shadow the app's root route. public/index.html is the
  // dev-mode Vite shell in Guren apps — never a production page.
  const shadowingIndex = resolve(out, 'assets/index.html')
  if (existsSync(shadowingIndex)) {
    rmSync(shadowingIndex)
  }

  // Built assets are emitted with the Guren Vite plugin's derived base
  // `/public/assets/` (chunk imports, CSS urls, preloads self-reference that
  // prefix). Vercel resolves it with a `/public/(.*) -> /$1` rewrite; Workers
  // Static Assets has no rewrites, so mirror the built-assets directory under
  // the base URL path as well: the root copy serves `/assets/*`, this copy
  // serves `/public/assets/*`.
  const clientAssetsDir = resolve(publicDir, 'assets')
  if (existsSync(clientAssetsDir)) {
    cpSync(clientAssetsDir, resolve(out, 'assets/public/assets'), { recursive: true })
  }

  writeFileSync(resolve(out, 'worker.js'), renderWorkerModule({ out, appEntry, ssrImport, assetEnv }))

  flattenD1Migrations(resolve(root, 'db/migrations'), resolve(out, 'd1-migrations'))

  writeDevOnlyStubs(out)

  scaffoldWranglerConfig(root, out, packageJson.name)
}

/**
 * Modules that exist in every Guren app's graph but can never run on
 * Workers, reached only through dev-time branches: `bun:sqlite` (the local
 * sqlite ORM factory, opposite the D1 branch of `config/database.ts`) and
 * `vite` (the dev asset server `Application` starts when serving locally).
 * Bundlers follow those imports anyway — even dynamic ones — so without
 * stubs the build either fails to resolve or ships megabytes of dev
 * tooling. Each stub throws if a code path ever really reaches it.
 */
const MCP_UNAVAILABLE = 'The MCP endpoint is unavailable on Cloudflare Workers — it generates files on disk.'

/**
 * Stubs must carry the exact names their importers destructure: an empty
 * module fails the bundle with "no matching export", not at runtime.
 */
function mcpStub(exportNames: string[]): string {
  const throwing = exportNames
    .map((name) => `export class ${name} { constructor() { throw new Error(${JSON.stringify(MCP_UNAVAILABLE)}) } }`)
    .join('\n')
  return `${throwing}\nexport default {}\n`
}

const DEV_ONLY_STUBS: Record<string, { file: string; source: string }> = {
  'bun:sqlite': {
    file: 'stub-bun-sqlite.js',
    source:
      'export const Database = class { constructor() { throw new Error("bun:sqlite is unavailable on Cloudflare Workers — use createD1Database().") } }\nexport default { Database }\n',
  },
  vite: {
    file: 'stub-vite.js',
    source:
      'export function createServer() { throw new Error("The Vite dev server is unavailable on Cloudflare Workers — assets are served by Workers Static Assets.") }\nexport default { createServer }\n',
  },
  // The opt-in MCP endpoint's lazy imports still drag the CLI generators
  // (and Babel) plus the MCP SDK into the bundle. `@guren/cli` is imported
  // bare, but the SDK is only ever reached through subpaths — and an alias
  // on a package name does not cover them, so each subpath is listed.
  // `@guren/cli` is imported bare and only read through namespace property
  // access, so an empty module suffices; the SDK subpaths are destructured
  // and need their names present. A package-name alias does not cover
  // subpaths, so each is listed.
  '@guren/cli': {
    file: 'stub-guren-cli.js',
    source: `// ${MCP_UNAVAILABLE}\nexport {}\n`,
  },
  '@modelcontextprotocol/sdk/server/mcp.js': {
    file: 'stub-mcp-server.js',
    source: mcpStub(['McpServer', 'ResourceTemplate']),
  },
  '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js': {
    file: 'stub-mcp-transport.js',
    source: mcpStub(['WebStandardStreamableHTTPServerTransport']),
  },
}

function writeDevOnlyStubs(out: string): void {
  for (const stub of Object.values(DEV_ONLY_STUBS)) {
    writeFileSync(resolve(out, stub.file), stub.source)
  }
}

function devOnlyAliases(outRelative: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(DEV_ONLY_STUBS).map(([specifier, stub]) => [
      specifier,
      `./${outRelative}/${stub.file}`,
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
}

async function resolveSsrImport(ssrDir: string, ssrEntryKey: string): Promise<SsrImport | undefined> {
  const manifest = loadManifest(
    resolve(ssrDir, '.vite/manifest.json'),
    resolve(ssrDir, 'manifest.json'),
  )

  const entryFile = manifest?.[ssrEntryKey]?.file
  if (!entryFile) {
    console.warn(
      `Cloudflare build: no SSR manifest entry for "${ssrEntryKey}" under ${ssrDir}; generating a CSR-only worker.`,
    )
    return undefined
  }

  const file = resolve(ssrDir, entryFile)
  if (!file.startsWith(ssrDir + sep)) {
    throw new Error(
      `Cloudflare build: SSR manifest entry "${entryFile}" escapes the SSR output directory ${ssrDir}.`,
    )
  }
  if (!existsSync(file)) {
    throw new Error(`Cloudflare build: SSR manifest points at ${file}, but the file does not exist.`)
  }

  const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  const renderer = module.render ?? module.default
  if (typeof renderer !== 'function') {
    throw new Error(
      `Cloudflare build: SSR entry ${file} does not export a renderer (expected a named "render" or default export).`,
    )
  }

  return { file }
}

interface ClientAssetEnv {
  entry?: string
  styles?: string
}

function resolveClientAssetEnv(root: string, clientEntryKey: string): ClientAssetEnv {
  const manifest = loadManifest(
    resolve(root, 'public/assets/.vite/manifest.json'),
    resolve(root, 'public/assets/manifest.json'),
  )

  const entry = manifest?.[clientEntryKey]
  if (!entry?.file) {
    console.warn(
      `Cloudflare build: no client manifest entry for "${clientEntryKey}"; GUREN_INERTIA_ENTRY will not be set.`,
    )
    return {}
  }

  return {
    entry: `/assets/${entry.file}`,
    styles: entry.css?.length ? entry.css.map((file) => `/assets/${file}`).join(',') : undefined,
  }
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
      `import * as ssrModule from ${JSON.stringify(importSpecifier(input.out, input.ssrImport.file))}`,
    )
  }

  lines.push(`import app from ${JSON.stringify(importSpecifier(input.out, input.appEntry))}`, '')

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
    lines.push('setInertiaSsrRenderer(ssrModule.render ?? ssrModule.default)', '')
  }

  lines.push('export default createWorkersHandler(app)', '')

  return lines.join('\n')
}

function importSpecifier(fromDir: string, target: string): string {
  const rel = relative(fromDir, target)
  if (isAbsolute(rel)) {
    throw new Error(
      `Cloudflare build: ${target} cannot be imported relative to ${fromDir} (different drive or root?). Keep the app, SSR output, and outputDir on the same volume.`,
    )
  }

  const specifier = rel.split(sep).join('/')
  return specifier.startsWith('.') ? specifier : `./${specifier}`
}

function scaffoldWranglerConfig(root: string, out: string, packageName: string | undefined): void {
  const configPath = resolve(root, 'wrangler.jsonc')
  if (existsSync(configPath)) {
    warnMissingBuildOwnedKeys(configPath, relative(root, out).split(sep).join('/'))
    return
  }

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

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`Cloudflare build: scaffolded ${configPath} — fill in d1_databases[0].database_id before deploying.`)
}

/**
 * The scaffold never overwrites an existing config, but `alias`, `define`,
 * and `migrations_dir` are build-owned invariants pointing into the output
 * directory — an app scaffolded before they existed deploys a worker that
 * cannot resolve `bun:sqlite` or never applies its migrations. Name exactly
 * what is missing rather than failing the build.
 */
function warnMissingBuildOwnedKeys(configPath: string, outRelative: string): void {
  let config: Record<string, unknown>
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    // Comments or trailing commas — a real JSONC file we should not guess at.
    return
  }

  const missing: string[] = []
  const alias = config.alias as Record<string, string> | undefined
  if (!alias || Object.keys(devOnlyAliases(outRelative)).some((key) => !(key in alias))) {
    missing.push(`"alias": ${JSON.stringify(devOnlyAliases(outRelative))}`)
  }
  const define = config.define as Record<string, string> | undefined
  if (!define?.['process.env.NODE_ENV']) {
    missing.push('"define": { "process.env.NODE_ENV": "\\"production\\"" }')
  }
  const d1 = (config.d1_databases as Array<Record<string, unknown>> | undefined)?.[0]
  if (d1 && d1.migrations_dir !== `${outRelative}/d1-migrations`) {
    missing.push(`"migrations_dir": "${outRelative}/d1-migrations" (inside d1_databases[0])`)
  }

  if (missing.length > 0) {
    console.warn(
      `Cloudflare build: ${configPath} predates this plugin version. Add the following or the worker will fail to start or skip migrations:\n  ${missing.join('\n  ')}`,
    )
  }
}

function resolvePathLike(value: PathLike): string {
  return value instanceof URL ? fileURLToPath(value) : resolve(String(value))
}

function loadManifest(...paths: string[]): Manifest | undefined {
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

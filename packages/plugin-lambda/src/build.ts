import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LAMBDA_HANDLER_EXPORTS, LAMBDA_HANDLER_MODULE } from './handlers'

type PathLike = string | URL

type ManifestEntry = {
  file?: string
  css?: string[]
}

type Manifest = Record<string, ManifestEntry>

interface PackageJsonLike {
  scripts?: Record<string, string>
}

export interface BuildLambdaOutputOptions {
  /** App root directory. Defaults to the current working directory. */
  rootDir?: PathLike
  /** Output directory for the assembled function. Defaults to `<root>/.lambda`. */
  outputDir?: PathLike
  /** Module exporting the Lambda handlers (http/queue/schedule/console). Defaults to `<root>/src/lambda.ts`. */
  entrypoint?: PathLike
  /** Static files directory staged for S3. Defaults to `<root>/public`. */
  publicDir?: PathLike
  /** Vite SSR build output. Defaults to `<root>/.guren/ssr`. */
  ssrDir?: PathLike
  /** Drizzle migrations copied into the function. Defaults to `<root>/db/migrations`. */
  migrationsDir?: PathLike
  /** Seeders copied into the function. Defaults to `<root>/db/seeders`. */
  seedersDir?: PathLike
  /** Client manifest key for the frontend entry. Defaults to `resources/js/app.tsx`. */
  clientEntryKey?: string
  /** SSR manifest key for the server entry. Defaults to `resources/js/ssr.tsx`. */
  ssrEntryKey?: string
  /** Skip running the app's `build` script before assembling output. */
  skipAppBuild?: boolean
  /** Also produce `<outputDir>/function.zip` (requires the `zip` binary). */
  zip?: boolean
}

const MCP_UNAVAILABLE = 'The MCP endpoint is unavailable on AWS Lambda — it generates files on disk.'

function mcpStub(exportNames: string[]): string {
  const throwing = exportNames
    .map((name) => `export class ${name} { constructor() { throw new Error(${JSON.stringify(MCP_UNAVAILABLE)}) } }`)
    .join('\n')
  return `${throwing}\nexport default {}\n`
}

/**
 * Modules that exist in every Guren app's graph but can never run on the
 * Lambda Node.js runtime, reached only through dev-time branches: `bun:sqlite`
 * (the local sqlite ORM factory), `vite` (the dev asset server), and the
 * opt-in MCP endpoint's generators. They are replaced with throwing stubs
 * rather than left external — inlining a lazily-imported module hoists that
 * module's own static imports to the bundle top level, so an external module
 * reached this way (the MCP SDK) would fail at import time on Lambda even
 * though no code path ever runs it. Stubbing also keeps megabytes of dev
 * tooling out of the bundle.
 */
const DEV_ONLY_STUBS: Record<string, string> = {
  'bun:sqlite':
    'export const Database = class { constructor() { throw new Error("bun:sqlite is unavailable on AWS Lambda — use createAwsDataApiDatabase() or createPostgresDatabase().") } }\nexport default { Database }\n',
  vite:
    'export function createServer() { throw new Error("The Vite dev server is unavailable on AWS Lambda — serve assets from S3/CloudFront.") }\nexport default { createServer }\n',
  '@guren/cli': `// ${MCP_UNAVAILABLE}\nexport {}\n`,
  '@modelcontextprotocol/sdk/server/mcp.js': mcpStub(['McpServer', 'ResourceTemplate']),
  '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js': mcpStub(['WebStandardStreamableHTTPServerTransport']),
}

// The MCP SDK is only ever reached through subpaths, so any of them — not
// just the two listed above — must resolve to a stub rather than the real
// package. Unlisted subpaths fall back to an empty throwing stub in onLoad.
const MCP_SDK_PREFIX = '@modelcontextprotocol/sdk/'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Derived from DEV_ONLY_STUBS so the record stays the only list of stubbed
// specifiers — a hand-maintained regex could silently fall out of sync.
const STUB_FILTER = new RegExp(
  `^(?:${[...Object.keys(DEV_ONLY_STUBS).map(escapeRegExp), `${escapeRegExp(MCP_SDK_PREFIX)}.+`].join('|')})$`,
)

/**
 * Assemble a deployable AWS Lambda directory (`.lambda/`) from a built Guren
 * app: a self-contained function bundle for the Node.js runtime, the SSR
 * bundle and migrations alongside it, static assets staged for S3, and an
 * `env.json` with the environment the function expects.
 */
export async function buildLambdaOutput(options: BuildLambdaOutputOptions = {}): Promise<void> {
  const root = resolvePathLike(options.rootDir ?? process.cwd())
  const out = resolvePathLike(options.outputDir ?? resolve(root, '.lambda'))
  const entrypoint = resolvePathLike(options.entrypoint ?? resolve(root, 'src/lambda.ts'))
  const publicDir = resolvePathLike(options.publicDir ?? resolve(root, 'public'))
  const ssrDir = resolvePathLike(options.ssrDir ?? resolve(root, '.guren/ssr'))
  const migrationsDir = resolvePathLike(options.migrationsDir ?? resolve(root, 'db/migrations'))
  const seedersDir = resolvePathLike(options.seedersDir ?? resolve(root, 'db/seeders'))
  const clientEntryKey = options.clientEntryKey ?? 'resources/js/app.tsx'
  const ssrEntryKey = options.ssrEntryKey ?? 'resources/js/ssr.tsx'

  if (out === root || root.startsWith(out + sep)) {
    throw new Error(
      `Lambda build: outputDir (${out}) must be a directory outside or below the app root, never the root itself — it is deleted on every build.`,
    )
  }

  const packageJson = readPackageJson(root)

  if (!options.skipAppBuild) {
    runAppBuild(root, packageJson.scripts ?? {})
  }

  if (!existsSync(entrypoint)) {
    throw new Error(
      `Lambda build: entrypoint not found at ${entrypoint}. Run \`bunx guren plugin @guren/plugin-lambda\` to scaffold src/lambda.ts, or pass "entrypoint".`,
    )
  }

  const ssrFile = resolveSsrEntry(ssrDir, ssrEntryKey)
  const assetEnv = resolveClientAssetEnv(publicDir, clientEntryKey)

  if (existsSync(out)) {
    rmSync(out, { recursive: true, force: true })
  }
  const funcDir = resolve(out, 'function')
  mkdirSync(funcDir, { recursive: true })

  stageStaticAssets(publicDir, resolve(out, 'assets'))

  const env = buildLambdaEnvironment(assetEnv, ssrFile, ssrDir)
  const wrapperPath = resolve(out, `${LAMBDA_HANDLER_MODULE}.ts`)
  writeFileSync(wrapperPath, renderHandlerModule({ out, entrypoint, env }))

  await bundleHandler(wrapperPath, funcDir)

  // Lambda's Node.js runtime treats `.js` as CommonJS unless the package is
  // marked as a module; the bundle and the SSR chunks are both ESM.
  writeFileSync(resolve(funcDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`)

  if (ssrFile) {
    cpSync(ssrDir, resolve(funcDir, '.guren/ssr'), { recursive: true })
  }

  if (existsSync(migrationsDir)) {
    cpSync(migrationsDir, resolve(funcDir, 'db/migrations'), { recursive: true })
  }

  if (existsSync(seedersDir)) {
    cpSync(seedersDir, resolve(funcDir, 'db/seeders'), { recursive: true })
  }

  writeFileSync(resolve(out, 'env.json'), `${JSON.stringify({ NODE_ENV: 'production', ...env }, null, 2)}\n`)

  if (options.zip) {
    zipFunction(out, funcDir)
  }
}

/**
 * Copy `public/` into the S3 staging directory. Vite emits built assets that
 * self-reference the derived base `/public/assets/`, while HTML references use
 * `/assets/`; S3 has no rewrites, so the built-assets directory is mirrored
 * under both prefixes. The dev-mode `index.html` shell is dropped — it must
 * never shadow the app's root route.
 */
function stageStaticAssets(publicDir: string, assetsOut: string): void {
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

function buildLambdaEnvironment(
  assetEnv: ClientAssetEnv,
  ssrFile: string | undefined,
  ssrDir: string,
): Record<string, string> {
  const env: Record<string, string> = {}

  if (assetEnv.entry) {
    env.GUREN_INERTIA_ENTRY = assetEnv.entry
  }
  if (assetEnv.styles) {
    env.GUREN_INERTIA_STYLES = assetEnv.styles
  }
  if (ssrFile) {
    // Relative specifiers resolve from process.cwd(), which is the function
    // root (/var/task) on Lambda — where the SSR bundle is copied.
    env.GUREN_INERTIA_SSR_ENTRY = `./.guren/ssr/${relative(ssrDir, ssrFile).split(sep).join('/')}`
    // Point at whichever manifest layout the SSR build actually produced —
    // resolveSsrEntry accepts the root-level fallback too.
    env.GUREN_INERTIA_SSR_MANIFEST = existsSync(resolve(ssrDir, '.vite/manifest.json'))
      ? './.guren/ssr/.vite/manifest.json'
      : './.guren/ssr/manifest.json'
  }

  return env
}

function renderHandlerModule(input: {
  out: string
  entrypoint: string
  env: Record<string, string>
}): string {
  const lines: string[] = [
    '// Generated by `guren lambda:build`. Do not edit — regenerate instead.',
    '',
    '// Baked as defaults so a deploy needs no function configuration; real',
    '// environment variables (e.g. absolute CloudFront URLs) still win.',
  ]

  for (const [key, value] of Object.entries(input.env)) {
    lines.push(`process.env.${key} ??= ${JSON.stringify(value)}`)
  }
  if (Object.keys(input.env).length > 0) {
    lines.push('')
  }

  lines.push(
    '// Imported dynamically so the assignments above run before the app module',
    '// graph evaluates — static imports are hoisted past them.',
    `const module = await import(${JSON.stringify(importSpecifier(input.out, input.entrypoint))})`,
    '',
  )

  for (const name of LAMBDA_HANDLER_EXPORTS) {
    if (name === 'console') {
      // A top-level `const console` would shadow the global inside this module.
      lines.push('const consoleHandler = module.console', 'export { consoleHandler as console }')
    } else {
      lines.push(`export const ${name} = module.${name}`)
    }
  }
  lines.push('')

  return lines.join('\n')
}

async function bundleHandler(handlerEntry: string, funcDir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [handlerEntry],
    outdir: funcDir,
    target: 'node',
    // `identifiers: false`: class names are runtime identity here.
    // `registerJob()`/`getJob()` key the job registry on `JobClass.name`, and
    // that name is serialized into every queued message (SqsDriver,
    // RedisDriver), a notification's persisted `type`, and `HttpException.name`
    // — mangling silently breaks all of them.
    //
    // Not `keepNames`/`--keep-names`: as of Bun 1.3.14 both are accepted and
    // silently leave class names mangled, so they cannot replace this.
    minify: { whitespace: true, syntax: true, identifiers: false },
    define: {
      // `bun build` inlines `process.env.NODE_ENV` at bundle time (defaulting
      // to "development"), so pin it to "production" for the deployed function.
      'process.env.NODE_ENV': '"production"',
      // Every module in the bundle shares one `import.meta.url` — the real
      // runtime value of the single output file, `file:///var/task/handler.js`.
      // That breaks the framework's `new URL('../db/migrations', import.meta.url)`
      // convention (config/database.ts, config/app.ts's migration check): those
      // files live one directory below the app root, so the same expression
      // must resolve from one level under /var/task to reach the db/migrations
      // and db/seeders folders `lambda:build` copies next to the bundle.
      'import.meta.url': '"file:///var/task/config/lambda.js"',
    },
    // Provided by the managed Lambda runtime.
    external: ['@aws-sdk/*'],
    plugins: [
      {
        name: 'guren-lambda-dev-stubs',
        setup(build) {
          build.onResolve({ filter: STUB_FILTER }, (args) => ({
            path: args.path,
            namespace: 'guren-lambda-stub',
          }))
          build.onLoad({ filter: /.*/, namespace: 'guren-lambda-stub' }, (args) => ({
            contents: DEV_ONLY_STUBS[args.path] ?? mcpStub([]),
            loader: 'js',
          }))
        },
      },
    ],
  })

  if (!result.success) {
    const details = result.logs.map((log) => String(log)).join('\n')
    throw new Error(`Lambda build: bun build failed.\n${details}`)
  }
}

function zipFunction(out: string, funcDir: string): void {
  const result = Bun.spawnSync({
    cmd: ['zip', '-qr', resolve(out, 'function.zip'), '.'],
    cwd: funcDir,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (result.exitCode !== 0) {
    throw new Error('Lambda build: zip failed. Install the `zip` binary or deploy the function directory directly (CDK archives it for you).')
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
    // API-only apps have no frontend build; there is nothing to run.
    console.warn('Lambda build: no "build" script in package.json — skipping the app build step.')
    return
  }

  const result = Bun.spawnSync({
    cmd: ['bun', 'run', 'build'],
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (result.exitCode !== 0) {
    throw new Error('Lambda build: the app "build" script failed.')
  }
}

/** Absolute path of the built SSR entry chunk, or undefined for CSR-only apps. */
function resolveSsrEntry(ssrDir: string, ssrEntryKey: string): string | undefined {
  const manifest = loadManifest(
    resolve(ssrDir, '.vite/manifest.json'),
    resolve(ssrDir, 'manifest.json'),
  )

  const entryFile = manifest?.[ssrEntryKey]?.file
  if (!entryFile) {
    return undefined
  }

  const file = resolve(ssrDir, entryFile)
  if (!file.startsWith(ssrDir + sep)) {
    throw new Error(
      `Lambda build: SSR manifest entry "${entryFile}" escapes the SSR output directory ${ssrDir}.`,
    )
  }
  if (!existsSync(file)) {
    throw new Error(`Lambda build: SSR manifest points at ${file}, but the file does not exist.`)
  }

  // Checked statically rather than by importing the chunk: executing the SSR
  // bundle here would run the app's module-scope side effects inside the
  // build. Without this check a missing renderer only surfaces at request
  // time as a silent fallback to client-side rendering.
  if (!hasRendererExport(readFileSync(file, 'utf8'))) {
    throw new Error(
      `Lambda build: SSR entry ${file} does not export a renderer (expected a named "render" or default export).`,
    )
  }

  return file
}

function hasRendererExport(source: string): boolean {
  // Re-export wildcards can't be verified without following the graph; accept.
  if (/export\s*\*\s*from/.test(source)) {
    return true
  }

  return (
    /export\s+default\b/.test(source) ||
    /export\s*\{[^}]*\b(?:render|default)\b[^}]*\}/.test(source) ||
    /export\s+(?:const|let|var|function|async\s+function)\s+render\b/.test(source)
  )
}

interface ClientAssetEnv {
  entry?: string
  styles?: string
}

function resolveClientAssetEnv(publicDir: string, clientEntryKey: string): ClientAssetEnv {
  const manifest = loadManifest(
    resolve(publicDir, 'assets/.vite/manifest.json'),
    resolve(publicDir, 'assets/manifest.json'),
  )

  const entry = manifest?.[clientEntryKey]
  if (!entry?.file) {
    console.warn(
      `Lambda build: no client manifest entry for "${clientEntryKey}"; GUREN_INERTIA_ENTRY will not be set.`,
    )
    return {}
  }

  return {
    entry: `/assets/${entry.file}`,
    styles: entry.css?.length ? entry.css.map((file) => `/assets/${file}`).join(',') : undefined,
  }
}

function importSpecifier(fromDir: string, target: string): string {
  const rel = relative(fromDir, target)
  if (isAbsolute(rel)) {
    throw new Error(
      `Lambda build: ${target} cannot be imported relative to ${fromDir} (different drive or root?). Keep the app, SSR output, and outputDir on the same volume.`,
    )
  }

  const specifier = rel.split(sep).join('/')
  return specifier.startsWith('.') ? specifier : `./${specifier}`
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

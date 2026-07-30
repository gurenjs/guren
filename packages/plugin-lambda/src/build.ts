import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import {
  assertOutputDirOutsideRoot,
  DEV_ONLY_MODULES,
  importSpecifier,
  loadManifest,
  MCP_SDK_SUBPATH_PREFIX,
  resolveClientAssetEnv,
  resolvePathLike,
  type ClientAssetEnv,
  type DevOnlyModule,
  type PathLike,
} from '@guren/core/internal/deploy-build'
import { LAMBDA_HANDLER_EXPORTS, LAMBDA_HANDLER_MODULE } from './handlers'

/** Prefixes every diagnostic this build emits. */
const LABEL = 'Lambda build'

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

/**
 * Why the dev-only modules in `DEV_ONLY_MODULES` cannot run here, worded for
 * this platform: each names the Lambda-appropriate replacement.
 */
const UNAVAILABLE_ON_LAMBDA: Record<DevOnlyModule['kind'], string> = {
  sqlite: 'bun:sqlite is unavailable on AWS Lambda — use createAwsDataApiDatabase() or createPostgresDatabase().',
  vite: 'The Vite dev server is unavailable on AWS Lambda — serve assets from S3/CloudFront.',
  mcp: MCP_UNAVAILABLE,
}

/**
 * Render a dev-only module as inline source for the bundler plugin below.
 *
 * Every name the importer destructures has to be present or the bundle fails
 * with "no matching export", so each is emitted as a throwing function. A
 * function rather than a class deliberately: the stubbed names are a mix of
 * constructors (`new Database()`) and plain calls (`createServer()`), and only
 * a function throws the intended message under both — invoking a class without
 * `new` reports "Class constructor cannot be invoked without 'new'" instead. A
 * module read only through namespace property access needs no names, and gets
 * a bare comment.
 */
function renderStub({ kind, exportNames }: DevOnlyModule): string {
  const message = UNAVAILABLE_ON_LAMBDA[kind]
  if (exportNames.length === 0) {
    return `// ${message}\nexport {}\n`
  }

  const throwing = exportNames
    .map((name) => `export function ${name}() { throw new Error(${JSON.stringify(message)}) }`)
    .join('\n')
  return `${throwing}\nexport default { ${exportNames.join(', ')} }\n`
}

/**
 * Dev-only modules replaced with throwing stubs rather than left external.
 * Inlining a lazily-imported module hoists that module's own static imports to
 * the bundle top level, so an external module reached this way (the MCP SDK)
 * would fail at import time on Lambda even though no code path ever runs it.
 * Stubbing also keeps megabytes of dev tooling out of the bundle.
 */
const DEV_ONLY_STUBS: Record<string, string> = Object.fromEntries(
  DEV_ONLY_MODULES.map((module) => [module.specifier, renderStub(module)]),
)

/**
 * Fallback for an MCP SDK subpath `DEV_ONLY_MODULES` does not name. It cannot
 * know which names the importer destructures, so it throws on evaluation
 * rather than resolving to an empty module: a subpath reached from app code
 * (not Guren's disabled MCP endpoint) must fail loudly at build or cold start,
 * never silently hand back missing exports.
 */
const unlistedMcpStub = `throw new Error(${JSON.stringify(MCP_UNAVAILABLE)})\n`

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Derived from the shared list so it stays the only enumeration of stubbed
// specifiers — a hand-maintained regex could silently fall out of sync.
const STUB_FILTER = new RegExp(
  `^(?:${[
    ...DEV_ONLY_MODULES.map((module) => escapeRegExp(module.specifier)),
    `${escapeRegExp(MCP_SDK_SUBPATH_PREFIX)}.+`,
  ].join('|')})$`,
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
  const clientEntryKey = options.clientEntryKey ?? 'resources/js/app.tsx'
  const ssrEntryKey = options.ssrEntryKey ?? 'resources/js/ssr.tsx'

  assertOutputDirOutsideRoot(out, root, LABEL)

  if (!options.skipAppBuild) {
    runAppBuild(root)
  }

  if (!existsSync(entrypoint)) {
    throw new Error(
      `Lambda build: entrypoint not found at ${entrypoint}. Run \`bunx guren plugin @guren/plugin-lambda\` to scaffold src/lambda.ts, or pass "entrypoint".`,
    )
  }

  const ssrFile = resolveSsrEntry(ssrDir, ssrEntryKey)
  const assetEnv = resolveClientAssetEnv(publicDir, clientEntryKey, LABEL)

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

  // Migrations travel with the function so a console-handler `db:migrate` can
  // apply them in place. Seeders deliberately do not: they are raw .ts modules
  // importing the app's schema and @guren/* packages, which the self-contained
  // bundle can never resolve — run them from the project source instead.
  if (existsSync(migrationsDir)) {
    cpSync(migrationsDir, resolve(funcDir, 'db/migrations'), { recursive: true })
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
  ]

  const envEntries = Object.entries(input.env)
  if (envEntries.length > 0) {
    lines.push(
      '// Baked as defaults so a deploy needs no function configuration; real',
      '// environment variables (e.g. absolute CloudFront URLs) still win.',
      ...envEntries.map(([key, value]) => `process.env.${key} ??= ${JSON.stringify(value)}`),
      '',
    )
  }

  lines.push(
    '// Imported dynamically so the assignments above run before the app module',
    '// graph evaluates — static imports are hoisted past them.',
    `const module = await import(${JSON.stringify(importSpecifier(input.out, input.entrypoint, LABEL))})`,
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
      // folder `lambda:build` copies next to the bundle.
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
            contents: DEV_ONLY_STUBS[args.path] ?? unlistedMcpStub,
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

function hasBuildScript(root: string): boolean {
  const packageJsonPath = resolve(root, 'package.json')
  if (!existsSync(packageJsonPath)) {
    return false
  }

  try {
    const { scripts } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>
    }
    return Boolean(scripts?.build)
  } catch {
    return false
  }
}

function runAppBuild(root: string): void {
  if (!hasBuildScript(root)) {
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


import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  scaffoldWranglerConfig(root, out, packageJson.name)
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
    return
  }

  const appName = (packageName ?? 'guren-app').replace(/^@[^/]+\//, '')
  const outRelative = relative(root, out).split(sep).join('/')

  const config = {
    name: appName,
    main: `${outRelative}/worker.js`,
    compatibility_date: new Date().toISOString().slice(0, 10),
    compatibility_flags: ['nodejs_compat'],
    assets: { directory: `${outRelative}/assets` },
    d1_databases: [
      {
        binding: 'DB',
        database_name: appName,
        database_id: 'TODO: wrangler d1 create',
        migrations_dir: 'db/migrations',
      },
    ],
    vars: { NODE_ENV: 'production' },
  }

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`Cloudflare build: scaffolded ${configPath} — fill in d1_databases[0].database_id before deploying.`)
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

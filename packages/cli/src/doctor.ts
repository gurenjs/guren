import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { consola } from 'consola'
import {
  discoverControllerFiles,
  discoverModelFiles,
  discoverTestFiles,
  fileExists,
  hasControllerTest,
  readIfExists,
  classNameFromPath,
  toPosixRelative,
  moduleNameFromRelPath,
} from './discovery'
import { checkPluginCompatibility, readCoreVersion, readInstalledPluginManifests } from './plugin-manifest'

export type DoctorStatus = 'pass' | 'warn' | 'fail'

export interface DoctorCheck {
  key: string
  title: string
  status: DoctorStatus
  message: string
  fix?: string
  canAutofix?: boolean
  manualFix?: string
}

export interface NextStep {
  priority: number
  title: string
  description: string
  filePath?: string
  command?: string
}

export interface DoctorReport {
  cwd: string
  checks: DoctorCheck[]
  fixableChecks: DoctorCheck[]
  manualChecks: DoctorCheck[]
  hasWarnings: boolean
  hasFailures: boolean
  nextSteps?: NextStep[]
  recommendedCommands: string[]
}

export interface RunDoctorOptions {
  cwd?: string
  json?: boolean
  next?: boolean
}

export interface DoctorAutofix {
  key: string
  title: string
  summary: string
  apply: (cwd: string) => Promise<void>
}

export interface DoctorRuleEvaluation {
  check: DoctorCheck
  autofix?: DoctorAutofix | null
}

export interface DoctorJsonOutput {
  version: 1
  cwd: string
  timestamp: string
  runtime: {
    name: string
    version: string | null
  }
  summary: {
    total: number
    pass: number
    warn: number
    fail: number
  }
  checks: Array<{
    key: string
    title: string
    status: DoctorStatus
    message: string
    fix: string | null
    canAutofix: boolean
    manualFix: string | null
  }>
  nextSteps: NextStep[] | null
  recommendedCommands: string[]
}

interface DoctorRuleContext {
  cwd: string
}

interface DoctorRule {
  key: string
  title: string
  detect: (context: DoctorRuleContext) => Promise<DoctorCheck>
  autofix?: (context: DoctorRuleContext, check: DoctorCheck) => Promise<DoctorAutofix | null>
}

type JsonReadResult<T> =
  | { exists: false; raw: null; value: null; parseError: null }
  | { exists: true; raw: string; value: T; parseError: null }
  | { exists: true; raw: string; value: null; parseError: Error }

const APP_ENTRY_CANDIDATES = ['src/main.ts', 'src/main.mts', 'src/main.js', 'src/main.mjs']
const ROUTE_CANDIDATES = ['routes/web.ts', 'routes/web.js', 'routes/api.ts', 'routes/api.js']
const PAGE_CONTRACT_CANDIDATES = ['.guren/pages.gen.ts']
const GENERATED_FILES = ['.guren/routes.gen.ts', '.guren/pages.gen.ts', '.guren/data.gen.ts', '.guren/api-client.gen.ts', '.guren/channels.gen.ts']

export const DOCTOR_RECOMMENDED_COMMANDS = [
  'bunx guren codegen --force',
  'bun run typecheck',
  'bun run build',
]

export const CANONICAL_APP_SCRIPTS = {
  dev: 'bun run codegen && bun run dev:server',
  // `dev` delegates here, so the pair has to be added together — adding `dev`
  // alone leaves it calling a script that does not exist. `--hot` is what makes
  // backend edits take effect without restarting the server.
  'dev:server': 'bun --hot bin/serve.ts',
  build: 'bun run codegen && bunx vite build',
  typecheck: 'tsc --noEmit',
  codegen: 'bunx guren codegen --routes routes/web.ts --out types/generated/routes.d.ts --force',
} as const

type PackageJsonShape = {
  scripts?: Record<string, string>
}

type PackageDependenciesShape = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

type TsconfigShape = {
  include?: string[]
  compilerOptions?: {
    baseUrl?: string
    paths?: Record<string, string[]>
  }
}

async function findFirstExisting(cwd: string, candidates: readonly string[]): Promise<string | null> {
  const results = await Promise.all(candidates.map((c) => fileExists(cwd, c)))
  const index = results.indexOf(true)
  return index === -1 ? null : candidates[index]
}

async function readJsonIfExists<T>(cwd: string, relativePath: string): Promise<JsonReadResult<T>> {
  const raw = await readIfExists(cwd, relativePath)
  if (raw === null) {
    return { exists: false, raw: null, value: null, parseError: null }
  }

  try {
    return {
      exists: true,
      raw,
      value: JSON.parse(raw) as T,
      parseError: null,
    }
  } catch (error) {
    return {
      exists: true,
      raw,
      value: null,
      parseError: error as Error,
    }
  }
}

async function writeJsonFile(cwd: string, relativePath: string, value: unknown): Promise<void> {
  await writeFile(resolve(cwd, relativePath), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function createCheck(
  key: string,
  title: string,
  status: DoctorStatus,
  message: string,
  options: {
    fix?: string
    canAutofix?: boolean
    manualFix?: string
  } = {},
): DoctorCheck {
  return {
    key,
    title,
    status,
    message,
    fix: options.fix,
    canAutofix: options.canAutofix,
    manualFix: options.manualFix,
  }
}

async function detectPackageJson(context: DoctorRuleContext): Promise<DoctorCheck> {
  const packageJson = await readJsonIfExists<Record<string, unknown>>(context.cwd, 'package.json')

  if (!packageJson.exists) {
    return createCheck(
      'package-json',
      'package.json',
      'fail',
      'No package.json was found in the current workspace.',
      {
        fix: 'Create a Guren app root or run `guren new` in an empty directory.',
        manualFix: 'Create a package.json for the application root before running upgrade or doctor.',
      },
    )
  }

  if (packageJson.parseError) {
    return createCheck(
      'package-json',
      'package.json',
      'fail',
      'package.json could not be parsed as strict JSON.',
      {
        fix: 'Fix package.json so it is valid JSON before running Guren maintenance commands.',
        manualFix: 'Repair package.json formatting so the CLI can read dependencies and scripts.',
      },
    )
  }

  return createCheck('package-json', 'package.json', 'pass', 'Workspace package.json detected.')
}

async function detectAppEntry(context: DoctorRuleContext): Promise<DoctorCheck> {
  const appEntry = await findFirstExisting(context.cwd, APP_ENTRY_CANDIDATES)
  if (!appEntry) {
    return createCheck(
      'app-entry',
      'Application Entry',
      'fail',
      'Could not find an application entry point in src/main.{ts,js,mts,mjs}.',
      {
        fix: 'Add src/main.ts and export a bootable application.',
        manualFix: 'Add src/main.ts so createApp() can be booted from a standard entry point.',
      },
    )
  }

  return createCheck('app-entry', 'Application Entry', 'pass', `Found ${appEntry}.`)
}

async function detectRoutes(context: DoctorRuleContext): Promise<DoctorCheck> {
  const routesFile = await findFirstExisting(context.cwd, ROUTE_CANDIDATES)
  if (!routesFile) {
    return createCheck(
      'routes',
      'Route Sources',
      'fail',
      'No routes/web.ts or routes/api.ts file was found.',
      {
        fix: 'Add a route registrar and pass it into createApp({ routes }).',
        manualFix: 'Add a route registrar and point createApp({ routes }) at it.',
      },
    )
  }

  return createCheck('routes', 'Route Sources', 'pass', `Found ${routesFile}.`)
}

async function detectPageContracts(context: DoctorRuleContext): Promise<DoctorCheck> {
  const pageContracts = await findFirstExisting(context.cwd, PAGE_CONTRACT_CANDIDATES)
  if (!pageContracts) {
    return createCheck(
      'page-contracts',
      'Page Types',
      'warn',
      'No .guren/pages.gen.ts file was found.',
      {
        fix: 'Run `bunx guren codegen --force` to generate page type definitions.',
        manualFix: 'Run `bunx guren codegen --force` to regenerate .guren/pages.gen.ts.',
      },
    )
  }

  return createCheck('page-contracts', 'Page Types', 'pass', `Found ${pageContracts}.`)
}

function createGeneratedManifestRule(generatedFile: string): DoctorRule {
  return {
    key: `generated:${generatedFile}`,
    title: generatedFile,
    async detect(context) {
      const present = await fileExists(context.cwd, generatedFile)
      return createCheck(
        `generated:${generatedFile}`,
        generatedFile,
        present ? 'pass' : 'warn',
        present
          ? `Generated manifest present at ${generatedFile}.`
          : `Missing generated manifest ${generatedFile}.`,
        {
          fix: `Run \`guren codegen --force\` to regenerate ${generatedFile}.`,
          manualFix: `Run \`guren codegen --force\` to regenerate ${generatedFile}.`,
        },
      )
    },
  }
}

async function detectTsconfig(context: DoctorRuleContext): Promise<DoctorCheck> {
  const tsconfig = await readJsonIfExists<TsconfigShape>(context.cwd, 'tsconfig.json')

  if (!tsconfig.exists) {
    return createCheck(
      'tsconfig',
      'TypeScript Config',
      'warn',
      'No tsconfig.json was found.',
      {
        fix: 'Add tsconfig.json and include `.guren/**/*` so generated contracts are type-checked.',
        manualFix: 'Add a tsconfig.json and include `.guren/**/*` in its include list.',
      },
    )
  }

  if (tsconfig.parseError) {
    return createCheck(
      'tsconfig',
      'TypeScript Config',
      'warn',
      'tsconfig.json could not be parsed as strict JSON.',
      {
        fix: 'Fix tsconfig.json so Guren can verify generated artifacts are included.',
        manualFix: 'Repair tsconfig.json formatting and add `.guren/**/*` to include.',
      },
    )
  }

  const includesGenerated = Array.isArray(tsconfig.value.include) && tsconfig.value.include.includes('.guren/**/*')
  return createCheck(
    'tsconfig',
    'TypeScript Config',
    includesGenerated ? 'pass' : 'warn',
    includesGenerated
      ? 'tsconfig.json includes generated .guren artifacts.'
      : 'tsconfig.json does not appear to include generated .guren artifacts.',
    {
      fix: 'Add `.guren/**/*` to the tsconfig include list.',
      canAutofix: !includesGenerated,
      manualFix: 'Add `.guren/**/*` to tsconfig.json include.',
    },
  )
}

const TSCONFIG_ALIAS_FIX = 'Set `"baseUrl": "."` and `"paths": { "@/*": ["./*"] }` in compilerOptions so `@/.guren/*` and `@/app/*` imports resolve.'

async function detectTsconfigAlias(context: DoctorRuleContext): Promise<DoctorCheck> {
  const tsconfig = await readJsonIfExists<TsconfigShape>(context.cwd, 'tsconfig.json')

  if (!tsconfig.exists || tsconfig.parseError || !tsconfig.value) {
    return createCheck('tsconfig-alias', 'Path Alias', 'pass', 'Skipped (tsconfig.json missing or unparseable; see TypeScript Config check).')
  }

  const compilerOptions = tsconfig.value.compilerOptions
  const aliasTargets = compilerOptions?.paths?.['@/*'] ?? []
  const baseUrl = compilerOptions?.baseUrl
  // Path mappings resolve relative to baseUrl (or the tsconfig directory when
  // baseUrl is omitted), so `./*` only means "project root" for a root baseUrl.
  const baseUrlIsRoot = baseUrl === undefined || baseUrl === '.' || baseUrl === './'
  const targetsRoot = aliasTargets.some((target) => target === './*' || target === '*')
  const mapsToRoot = targetsRoot && baseUrlIsRoot

  const message = mapsToRoot
    ? 'tsconfig.json maps `@/*` to the project root.'
    : aliasTargets.length === 0
      ? 'tsconfig.json does not define the `@/*` path alias.'
      : !targetsRoot
        ? `tsconfig.json maps \`@/*\` to ${JSON.stringify(aliasTargets)} instead of the project root (\`["./*"]\`). Scaffolded code imports \`@/.guren/*\` and \`@/app/*\` relative to the project root; adjust existing \`@/\` imports when changing the mapping.`
        : `tsconfig.json maps \`@/*\` to \`["./*"]\` but \`baseUrl\` is ${JSON.stringify(baseUrl)}, so the alias resolves under that directory instead of the project root.`

  return createCheck('tsconfig-alias', 'Path Alias', mapsToRoot ? 'pass' : 'warn', message, {
    fix: TSCONFIG_ALIAS_FIX,
    manualFix: TSCONFIG_ALIAS_FIX,
    // Only safe to autofix when the alias is absent and no custom baseUrl would
    // repoint it — rewriting existing settings could break imports that rely on
    // the old resolution.
    canAutofix: aliasTargets.length === 0 && baseUrlIsRoot,
  })
}

async function createTsconfigAliasAutofix(_context: DoctorRuleContext, check: DoctorCheck): Promise<DoctorAutofix | null> {
  if (check.status === 'pass' || !check.canAutofix) {
    return null
  }

  return {
    key: check.key,
    title: check.title,
    summary: 'Add `"baseUrl": "."` and `"paths": { "@/*": ["./*"] }` to tsconfig.json.',
    async apply(cwd: string) {
      const current = await readJsonIfExists<TsconfigShape>(cwd, 'tsconfig.json')
      if (!current.exists || current.parseError || !current.value) {
        return
      }

      const nextConfig = { ...current.value }
      const compilerOptions = { ...nextConfig.compilerOptions }
      compilerOptions.baseUrl ??= '.'
      compilerOptions.paths = { ...compilerOptions.paths }
      compilerOptions.paths['@/*'] ??= ['./*']
      nextConfig.compilerOptions = compilerOptions
      await writeJsonFile(cwd, 'tsconfig.json', nextConfig)
    },
  }
}

async function createTsconfigAutofix(_context: DoctorRuleContext, check: DoctorCheck): Promise<DoctorAutofix | null> {
  if (check.status === 'pass' || !check.canAutofix) {
    return null
  }

  return {
    key: check.key,
    title: check.title,
    summary: 'Add `.guren/**/*` to tsconfig.json include.',
    async apply(cwd: string) {
      const current = await readJsonIfExists<TsconfigShape>(cwd, 'tsconfig.json')
      if (!current.exists || current.parseError || !current.value) {
        return
      }

      const nextConfig = { ...current.value }
      const include = Array.isArray(nextConfig.include) ? [...nextConfig.include] : []
      if (!include.includes('.guren/**/*')) {
        include.push('.guren/**/*')
      }
      nextConfig.include = include
      await writeJsonFile(cwd, 'tsconfig.json', nextConfig)
    },
  }
}

async function detectBootstrap(context: DoctorRuleContext): Promise<DoctorCheck> {
  const appEntry = await findFirstExisting(context.cwd, APP_ENTRY_CANDIDATES)
  if (!appEntry) {
    return createCheck(
      'bootstrap',
      'Bootstrap Style',
      'warn',
      'Could not inspect application bootstrap because no app entry was found.',
      {
        fix: 'Prefer `createApp({ routes, providers, features })` over side-effect bootstrapping.',
        manualFix: 'Adopt `createApp({ routes, providers, features })` in src/app.ts or src/main.ts.',
      },
    )
  }

  const appEntryRaw = await readIfExists(context.cwd, appEntry)
  const appSourceCandidates = [appEntryRaw]
  if (await fileExists(context.cwd, 'src/app.ts')) {
    appSourceCandidates.push(await readIfExists(context.cwd, 'src/app.ts'))
  }

  const combinedSource = appSourceCandidates.filter((value): value is string => typeof value === 'string').join('\n')
  const usesCreateApp = combinedSource.includes('createApp(')
  const usesLegacyApplication = combinedSource.includes('new Application(')

  return createCheck(
    'bootstrap',
    'Bootstrap Style',
    usesCreateApp ? 'pass' : 'warn',
    usesCreateApp
      ? 'Application bootstrap uses createApp().'
      : usesLegacyApplication
        ? 'Application bootstrap still uses new Application().'
        : 'Could not detect createApp() in the application bootstrap.',
    {
      fix: 'Prefer `createApp({ routes, providers, features })` over side-effect bootstrapping.',
      manualFix: 'Migrate bootstrap to createApp({ routes, providers, features }).',
    },
  )
}

async function detectScripts(context: DoctorRuleContext): Promise<DoctorCheck> {
  const packageJson = await readJsonIfExists<PackageJsonShape>(context.cwd, 'package.json')
  if (!packageJson.exists) {
    return createCheck(
      'scripts',
      'App Scripts',
      'warn',
      'package.json is missing, so recommended app scripts could not be verified.',
      {
        fix: 'Add `dev`, `dev:server`, `build`, `typecheck`, and `codegen` scripts to package.json.',
        manualFix: 'Create package.json and add the standard app scripts.',
      },
    )
  }

  if (packageJson.parseError || !packageJson.value) {
    return createCheck(
      'scripts',
      'App Scripts',
      'warn',
      'package.json could not be parsed, so app scripts could not be verified.',
      {
        fix: 'Fix package.json so Guren can manage the standard app scripts.',
        manualFix: 'Repair package.json formatting and add the standard app scripts.',
      },
    )
  }

  const scripts = packageJson.value.scripts ?? {}
  const missingScripts = Object.keys(CANONICAL_APP_SCRIPTS).filter((script) => !(script in scripts))

  return createCheck(
    'scripts',
    'App Scripts',
    missingScripts.length === 0 ? 'pass' : 'warn',
    missingScripts.length === 0
      ? 'package.json exposes dev/dev:server/build/typecheck/codegen scripts.'
      : `package.json is missing recommended scripts: ${missingScripts.join(', ')}.`,
    {
      fix: 'Add `dev`, `dev:server`, `build`, `typecheck`, and `codegen` scripts to package.json.',
      canAutofix: missingScripts.length > 0,
      manualFix: 'Add the standard dev/dev:server/build/typecheck/codegen scripts to package.json.',
    },
  )
}

async function createScriptsAutofix(_context: DoctorRuleContext, check: DoctorCheck): Promise<DoctorAutofix | null> {
  if (check.status === 'pass' || !check.canAutofix) {
    return null
  }

  return {
    key: check.key,
    title: check.title,
    summary: 'Add missing recommended scripts to package.json.',
    async apply(cwd: string) {
      const current = await readJsonIfExists<PackageJsonShape>(cwd, 'package.json')
      if (!current.exists || current.parseError || !current.value) {
        return
      }

      const nextManifest = { ...current.value }
      const scripts = { ...(nextManifest.scripts ?? {}) }
      for (const [name, command] of Object.entries(CANONICAL_APP_SCRIPTS)) {
        if (!(name in scripts)) {
          scripts[name] = command
        }
      }
      nextManifest.scripts = scripts
      await writeJsonFile(cwd, 'package.json', nextManifest)
    },
  }
}

const MIN_BUN_VERSION = '1.1.0'

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na !== nb) return na - nb
  }
  return 0
}

async function detectBunVersion(context: DoctorRuleContext): Promise<DoctorCheck> {
  const bunVersion = typeof process !== 'undefined' && process.versions?.bun
    ? process.versions.bun
    : null

  if (!bunVersion) {
    return createCheck(
      'bun-version',
      'Bun Version',
      'fail',
      'Could not detect Bun runtime version. Guren requires Bun >= 1.1.0.',
      {
        fix: 'Install or update Bun with `bun upgrade`.',
        manualFix: 'Install Bun from https://bun.sh and ensure version >= 1.1.0.',
      },
    )
  }

  const cmp = compareVersions(bunVersion, MIN_BUN_VERSION)

  if (cmp >= 0) {
    return createCheck(
      'bun-version',
      'Bun Version',
      'pass',
      `Bun ${bunVersion} detected (minimum: ${MIN_BUN_VERSION}).`,
    )
  }

  // Version is below minimum — check if critically old (< 1.0.0)
  const critical = compareVersions(bunVersion, '1.0.0') < 0

  return createCheck(
    'bun-version',
    'Bun Version',
    critical ? 'fail' : 'warn',
    `Bun ${bunVersion} detected, but Guren requires >= ${MIN_BUN_VERSION}.`,
    {
      fix: 'Update Bun with `bun upgrade`.',
      manualFix: `Upgrade Bun to >= ${MIN_BUN_VERSION} by running \`bun upgrade\`.`,
    },
  )
}

async function detectRuntime(_context: DoctorRuleContext): Promise<DoctorCheck> {
  const isBun = typeof process !== 'undefined' && !!process.versions?.bun
  const isNode = typeof process !== 'undefined' && !!process.versions?.node && !isBun

  if (isNode) {
    return createCheck(
      'runtime',
      'Runtime Environment',
      'warn',
      `Running under Node.js ${process.versions.node}. Guren is designed for Bun and some features may not work correctly.`,
      {
        fix: 'Install Bun from https://bun.sh and run the project with `bun` instead of `node`.',
        manualFix: 'Switch to Bun runtime for full framework compatibility.',
      },
    )
  }

  if (!isBun) {
    return createCheck(
      'runtime',
      'Runtime Environment',
      'fail',
      'Could not detect Bun or Node.js runtime. Guren requires the Bun runtime.',
      {
        fix: 'Install Bun from https://bun.sh.',
        manualFix: 'Install Bun from https://bun.sh and ensure it is in your PATH.',
      },
    )
  }

  return createCheck(
    'runtime',
    'Runtime Environment',
    'pass',
    'Running under Bun runtime.',
  )
}

async function detectConfigDrift(context: DoctorRuleContext): Promise<DoctorCheck> {
  const appEntry = await findFirstExisting(context.cwd, APP_ENTRY_CANDIDATES)
  if (!appEntry) {
    return createCheck(
      'config-drift',
      'App Wiring',
      'warn',
      'Could not inspect app wiring because no entry point was found.',
      {
        fix: 'Create src/main.ts with createApp() to establish the application entry.',
        manualFix: 'Add src/main.ts as the application entry point.',
      },
    )
  }

  const appEntryRaw = await readIfExists(context.cwd, appEntry)
  const appSourceCandidates = [appEntryRaw]
  if (await fileExists(context.cwd, 'src/app.ts')) {
    appSourceCandidates.push(await readIfExists(context.cwd, 'src/app.ts'))
  }

  const combinedSource = appSourceCandidates.filter((value): value is string => typeof value === 'string').join('\n')

  if (!combinedSource.includes('createApp(')) {
    return createCheck(
      'config-drift',
      'App Wiring',
      'warn',
      'createApp() not found in app sources; cannot verify wiring.',
      {
        fix: 'Use createApp({ routes, providers }) in src/app.ts.',
        manualFix: 'Migrate to createApp() for proper app wiring.',
      },
    )
  }

  const issues: string[] = []

  // Check routes wiring
  const hasRoutesImport = combinedSource.includes('routes') && (
    combinedSource.includes("from 'routes/") ||
    combinedSource.includes("from '@/routes/") ||
    combinedSource.includes("from '../routes/") ||
    combinedSource.includes("from './routes/") ||
    combinedSource.includes('routes:') ||
    combinedSource.includes('routes,')
  )
  const routeFileExists = await findFirstExisting(context.cwd, ROUTE_CANDIDATES)

  if (routeFileExists && !hasRoutesImport) {
    issues.push('Route file exists but may not be wired into createApp()')
  }

  // Check providers wiring
  const hasProviders = combinedSource.includes('providers')
  const providerDir = await fileExists(context.cwd, 'app/Providers')
  if (providerDir && !hasProviders) {
    issues.push('Providers directory exists but may not be wired into createApp()')
  }

  // Check that DatabaseProvider is present when database config exists
  const dbConfigFile = await findFirstExisting(context.cwd, DATABASE_CONFIG_CANDIDATES)
  if (dbConfigFile) {
    const hasDatabaseProvider = combinedSource.includes('DatabaseProvider') ||
      combinedSource.includes('database') ||
      combinedSource.includes('orm')
    if (!hasDatabaseProvider) {
      issues.push('Database config exists but DatabaseProvider may not be registered')
    }
  }

  if (issues.length > 0) {
    return createCheck(
      'config-drift',
      'App Wiring',
      'warn',
      `Possible config drift detected: ${issues.join('; ')}.`,
      {
        fix: 'Ensure routes, providers, and features are all passed to createApp().',
        manualFix: `Review src/app.ts wiring: ${issues.join('; ')}.`,
      },
    )
  }

  return createCheck(
    'config-drift',
    'App Wiring',
    'pass',
    'App wiring appears consistent.',
  )
}

async function detectEnvFile(context: DoctorRuleContext): Promise<DoctorCheck> {
  const envExists = await fileExists(context.cwd, '.env')
  const envExampleExists = await fileExists(context.cwd, '.env.example')

  if (envExists) {
    return createCheck(
      'env-file',
      'Environment File',
      'pass',
      '.env file detected.',
    )
  }

  if (envExampleExists) {
    return createCheck(
      'env-file',
      'Environment File',
      'warn',
      '.env file is missing, but .env.example exists.',
      {
        fix: 'Copy .env.example to .env: `cp .env.example .env`',
        canAutofix: true,
        manualFix: 'Copy .env.example to .env and configure environment variables.',
      },
    )
  }

  return createCheck(
    'env-file',
    'Environment File',
    'fail',
    'Neither .env nor .env.example was found.',
    {
      fix: 'Create a .env file with your environment configuration.',
      manualFix: 'Create a .env file in the project root with the required environment variables.',
    },
  )
}

function readEnvVar(content: string, name: string): string | null {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separator = trimmed.indexOf('=')
    if (separator === -1) {
      continue
    }

    if (trimmed.slice(0, separator) === name) {
      return trimmed.slice(separator + 1)
    }
  }

  return null
}

function isValidAppKey(rawValue: string): boolean {
  const trimmed = rawValue.trim()
  if (!trimmed) {
    return false
  }

  const encoded = trimmed.startsWith('base64:') ? trimmed.slice('base64:'.length) : trimmed
  const decoded = Buffer.from(encoded, 'base64')
  return decoded.length === 32 && decoded.toString('base64') === encoded
}

async function detectAppKey(context: DoctorRuleContext): Promise<DoctorCheck> {
  const envContent = await readIfExists(context.cwd, '.env')
  if (envContent !== null) {
    const rawValue = readEnvVar(envContent, 'APP_KEY')
    if (!rawValue) {
      return createCheck('app-key', 'APP_KEY', 'fail', 'APP_KEY is missing from .env.', {
        fix: 'Run `bunx guren key:generate --write` to populate APP_KEY in .env.',
        manualFix: 'Add APP_KEY=base64:... to .env with a valid 32-byte key.',
      })
    }

    if (!isValidAppKey(rawValue)) {
      return createCheck('app-key', 'APP_KEY', 'fail', 'APP_KEY in .env is invalid.', {
        fix: 'Run `bunx guren key:generate --write` to replace APP_KEY with a valid value.',
        manualFix: 'Replace APP_KEY in .env with a valid base64: 32-byte key.',
      })
    }

    return createCheck('app-key', 'APP_KEY', 'pass', 'Valid APP_KEY found in .env.')
  }

  const envExampleContent = await readIfExists(context.cwd, '.env.example')
  if (envExampleContent !== null) {
    const rawValue = readEnvVar(envExampleContent, 'APP_KEY')
    if (rawValue === null) {
      return createCheck('app-key', 'APP_KEY', 'warn', '.env.example does not define APP_KEY.', {
        fix: 'Add APP_KEY= to .env.example so new environments know a key is required.',
        manualFix: 'Document APP_KEY in .env.example.',
      })
    }

    return createCheck('app-key', 'APP_KEY', 'warn', '.env.example documents APP_KEY, but .env is missing.', {
      fix: 'Copy .env.example to .env and run `bunx guren key:generate --write`.',
      manualFix: 'Create .env and assign a valid APP_KEY before running the app.',
    })
  }

  return createCheck('app-key', 'APP_KEY', 'warn', 'No .env or .env.example found to validate APP_KEY.', {
    fix: 'Create .env with APP_KEY=base64:... before running the application.',
    manualFix: 'Add APP_KEY to .env or .env.example.',
  })
}

async function createEnvFileAutofix(_context: DoctorRuleContext, check: DoctorCheck): Promise<DoctorAutofix | null> {
  if (check.status === 'pass' || !check.canAutofix) {
    return null
  }

  return {
    key: check.key,
    title: check.title,
    summary: 'Copy .env.example to .env.',
    async apply(cwd: string) {
      const exampleExists = await fileExists(cwd, '.env.example')
      if (!exampleExists) {
        return
      }
      await copyFile(resolve(cwd, '.env.example'), resolve(cwd, '.env'))
    },
  }
}

const DATABASE_CONFIG_CANDIDATES = ['config/database.ts', 'db/config.ts']

async function detectDatabaseConfig(context: DoctorRuleContext): Promise<DoctorCheck> {
  const configFile = await findFirstExisting(context.cwd, DATABASE_CONFIG_CANDIDATES)

  if (!configFile) {
    return createCheck(
      'database-config',
      'Database Configuration',
      'warn',
      'No database configuration file found (checked config/database.ts and db/config.ts).',
      {
        fix: 'Create a database configuration file at config/database.ts.',
        manualFix: 'Add config/database.ts using createPostgresDatabase() from @guren/orm.',
      },
    )
  }

  // Check if .env exists and has DATABASE_URL
  const envContent = await readIfExists(context.cwd, '.env')
  if (envContent !== null) {
    const hasDatabaseUrl = envContent.split('\n').some((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('#') && trimmed.startsWith('DATABASE_URL')
    })

    if (!hasDatabaseUrl) {
      return createCheck(
        'database-config',
        'Database Configuration',
        'warn',
        `Found ${configFile}, but DATABASE_URL may be missing from .env.`,
        {
          fix: 'Add DATABASE_URL to your .env file (e.g., DATABASE_URL=postgres://user:pass@localhost:5432/dbname).',
          manualFix: 'Check that DATABASE_URL is defined in .env with a valid connection string.',
        },
      )
    }
  }

  return createCheck(
    'database-config',
    'Database Configuration',
    'pass',
    `Found ${configFile}.`,
  )
}

/**
 * Checks whether the project has any test foundation at all: either
 * `@guren/testing` is installed, or at least one `*.test.ts`-style file
 * already exists under `tests/`. Older `create-guren-app` scaffolds and
 * hand-rolled projects can have neither, which leaves `guren doctor`
 * silent even though there is no way to write a controller test.
 */
async function hasTestInfrastructure(cwd: string): Promise<boolean> {
  const packageJson = await readJsonIfExists<PackageDependenciesShape>(cwd, 'package.json')
  const hasTestingPackage = Boolean(
    packageJson.value?.dependencies?.['@guren/testing'] ||
    packageJson.value?.devDependencies?.['@guren/testing'],
  )

  if (hasTestingPackage) {
    return true
  }

  const testFiles = await discoverTestFiles(cwd).catch(() => [] as string[])
  return testFiles.length > 0
}

async function detectTestInfrastructure(context: DoctorRuleContext): Promise<DoctorCheck> {
  const present = await hasTestInfrastructure(context.cwd)

  if (present) {
    return createCheck(
      'test-infrastructure',
      'Test Infrastructure',
      'pass',
      'Test infrastructure detected (@guren/testing dependency or test files present).',
    )
  }

  return createCheck(
    'test-infrastructure',
    'Test Infrastructure',
    'warn',
    'No @guren/testing dependency and no test files were found; the project has no test foundation.',
    {
      fix: 'Run `bun add -d @guren/testing` and scaffold a first test with `bunx guren make:test`.',
      manualFix: 'Add @guren/testing to devDependencies and create test files under tests/.',
    },
  )
}

async function detectPluginCompatibility(context: DoctorRuleContext): Promise<DoctorCheck> {
  const [plugins, coreVersion] = await Promise.all([
    readInstalledPluginManifests(context.cwd),
    readCoreVersion(context.cwd),
  ])

  const incompatible: string[] = []
  const unverified: string[] = []

  for (const { packageName, manifest } of plugins) {
    const compatibility = checkPluginCompatibility(manifest, coreVersion)
    if (compatibility === null && manifest.compatibility) {
      unverified.push(packageName)
    } else if (compatibility && !compatibility.compatible) {
      incompatible.push(
        `${packageName} (declares "${compatibility.range}", installed @guren/core is ${compatibility.coreVersion})`,
      )
    }
  }

  if (incompatible.length > 0) {
    return createCheck(
      'plugin-compatibility',
      'Plugin Compatibility',
      'warn',
      `Incompatible plugins: ${incompatible.join('; ')}.`,
      {
        manualFix: 'Upgrade the plugin(s) to a version that supports the installed Guren release, or upgrade @guren/core.',
      },
    )
  }

  if (unverified.length > 0) {
    return createCheck(
      'plugin-compatibility',
      'Plugin Compatibility',
      'warn',
      `Could not verify compatibility for: ${unverified.join(', ')} (@guren/core version unresolved).`,
      {
        manualFix: 'Install dependencies so node_modules/@guren/core/package.json is available.',
      },
    )
  }

  return createCheck(
    'plugin-compatibility',
    'Plugin Compatibility',
    'pass',
    plugins.length > 0
      ? `${plugins.length} plugin(s) compatible with the installed Guren version.`
      : 'No Guren plugins detected.',
  )
}

const doctorRules: DoctorRule[] = [
  { key: 'runtime', title: 'Runtime Environment', detect: detectRuntime },
  { key: 'bun-version', title: 'Bun Version', detect: detectBunVersion },
  { key: 'package-json', title: 'package.json', detect: detectPackageJson },
  { key: 'env-file', title: 'Environment File', detect: detectEnvFile, autofix: createEnvFileAutofix },
  { key: 'app-key', title: 'APP_KEY', detect: detectAppKey },
  { key: 'app-entry', title: 'Application Entry', detect: detectAppEntry },
  { key: 'routes', title: 'Route Sources', detect: detectRoutes },
  { key: 'page-contracts', title: 'Page Types', detect: detectPageContracts },
  ...GENERATED_FILES.map((generatedFile) => createGeneratedManifestRule(generatedFile)),
  { key: 'tsconfig', title: 'TypeScript Config', detect: detectTsconfig, autofix: createTsconfigAutofix },
  { key: 'tsconfig-alias', title: 'Path Alias', detect: detectTsconfigAlias, autofix: createTsconfigAliasAutofix },
  { key: 'bootstrap', title: 'Bootstrap Style', detect: detectBootstrap },
  { key: 'config-drift', title: 'App Wiring', detect: detectConfigDrift },
  { key: 'scripts', title: 'App Scripts', detect: detectScripts, autofix: createScriptsAutofix },
  { key: 'database-config', title: 'Database Configuration', detect: detectDatabaseConfig },
  { key: 'test-infrastructure', title: 'Test Infrastructure', detect: detectTestInfrastructure },
  { key: 'plugin-compatibility', title: 'Plugin Compatibility', detect: detectPluginCompatibility },
]

export async function getDoctorRuleEvaluations(options: { cwd?: string } = {}): Promise<{
  cwd: string
  evaluations: DoctorRuleEvaluation[]
}> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const context: DoctorRuleContext = { cwd }

  const evaluations = await Promise.all(
    doctorRules.map(async (rule) => {
      const check = await rule.detect(context)
      const autofix = rule.autofix && check.status !== 'pass'
        ? await rule.autofix(context, check)
        : null
      return { check, autofix } as DoctorRuleEvaluation
    }),
  )

  return { cwd, evaluations }
}

export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const { cwd, evaluations } = await getDoctorRuleEvaluations({ cwd: options.cwd })
  const checks = evaluations.map((evaluation) => evaluation.check)
  const fixableChecks = checks.filter((check) => check.status !== 'pass' && Boolean(check.canAutofix))
  const manualChecks = checks.filter((check) => check.status !== 'pass' && !check.canAutofix)

  const report: DoctorReport = {
    cwd,
    checks,
    fixableChecks,
    manualChecks,
    hasWarnings: checks.some((check) => check.status === 'warn'),
    hasFailures: checks.some((check) => check.status === 'fail'),
    recommendedCommands: [...DOCTOR_RECOMMENDED_COMMANDS],
  }

  if (options.next) {
    report.nextSteps = await suggestNextSteps({ cwd })
  }

  if (options.json) {
    const jsonOutput = buildJsonOutput(report)
    console.log(JSON.stringify(jsonOutput, null, 2))
  } else {
    renderDoctorReport(report)
  }

  return report
}

export function buildJsonOutput(report: DoctorReport): DoctorJsonOutput {
  const isBun = typeof process !== 'undefined' && !!process.versions?.bun
  const runtimeVersion = isBun
    ? process.versions.bun
    : (process.versions?.node ?? null)

  return {
    version: 1,
    cwd: report.cwd,
    timestamp: new Date().toISOString(),
    runtime: {
      name: isBun ? 'bun' : 'node',
      version: runtimeVersion,
    },
    summary: report.checks.reduce(
      (acc, c) => { acc.total++; acc[c.status]++; return acc },
      { total: 0, pass: 0, warn: 0, fail: 0 },
    ),
    checks: report.checks.map((c) => ({
      key: c.key,
      title: c.title,
      status: c.status,
      message: c.message,
      fix: c.fix ?? null,
      canAutofix: c.canAutofix ?? false,
      manualFix: c.manualFix ?? null,
    })),
    nextSteps: report.nextSteps ?? null,
    recommendedCommands: report.recommendedCommands,
  }
}

export async function suggestNextSteps(options: { cwd?: string } = {}): Promise<NextStep[]> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const steps: NextStep[] = []
  let priority = 1

  const controllerFiles = await discoverControllerFiles(cwd).catch(() => [] as string[])

  const testInfraPresent = await hasTestInfrastructure(cwd).catch(() => true)
  if (!testInfraPresent) {
    steps.push({
      priority: priority++,
      title: 'Install test infrastructure',
      description: 'No @guren/testing dependency and no test files were found; the project has no test foundation.',
      command: 'bun add -d @guren/testing',
    })
  }

  try {
    for (const filePath of controllerFiles) {
      const source = await readFile(filePath, 'utf-8')
      const { parse } = await import('@babel/parser')
      let ast
      try {
        ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
      } catch {
        continue
      }

      for (const node of ast.program.body) {
        let classDecl = null
        if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration') {
          classDecl = node.declaration
        } else if (node.type === 'ExportDefaultDeclaration' && node.declaration?.type === 'ClassDeclaration') {
          classDecl = node.declaration
        }
        if (!classDecl) continue
        const className = classDecl.id?.name ?? classNameFromPath(filePath)

        for (const member of classDecl.body.body) {
          if (
            member.type === 'ClassMethod' &&
            member.key.type === 'Identifier' &&
            member.key.name !== 'constructor' &&
            member.body.body.length === 0
          ) {
            steps.push({
              priority: priority++,
              title: `Implement ${className}.${member.key.name}()`,
              description: 'Method has an empty body.',
              filePath: relative(cwd, filePath),
            })
          }
        }
      }
    }
  } catch {
    // Ignore parse failures
  }

  try {
    for (const filePath of controllerFiles) {
      const name = classNameFromPath(filePath)
      if (!(await hasControllerTest(cwd, filePath))) {
        const moduleName = moduleNameFromRelPath(toPosixRelative(cwd, filePath))
        const moduleFlag = moduleName ? ` --module ${moduleName}` : ''
        steps.push({
          priority: priority++,
          title: `Add tests for ${name}`,
          description: 'No test file found.',
          command: `bunx guren make:test ${name.replace('Controller', '')} --controller${moduleFlag}`,
        })
      }
    }
  } catch {
    // Ignore
  }

  try {
    const modelFiles = await discoverModelFiles(cwd)
    for (const filePath of modelFiles) {
      const name = classNameFromPath(filePath)
      const factoryCandidates = [
        `database/factories/${name}Factory.ts`,
        `db/factories/${name}Factory.ts`,
      ]
      let hasFactory = false
      for (const candidate of factoryCandidates) {
        if (await fileExists(cwd, candidate)) {
          hasFactory = true
          break
        }
      }
      if (!hasFactory) {
        steps.push({
          priority: priority++,
          title: `Add factory for ${name}`,
          description: 'No factory file found for testing and seeding.',
          command: `bunx guren make:factory ${name}`,
        })
      }
    }
  } catch {
    // Ignore
  }

  let missingManifests = false
  for (const manifest of ['.guren/routes.gen.ts', '.guren/pages.gen.ts', '.guren/data.gen.ts', '.guren/api-client.gen.ts']) {
    if (!(await fileExists(cwd, manifest))) {
      missingManifests = true
      break
    }
  }
  if (missingManifests) {
    steps.push({
      priority: priority++,
      title: 'Run codegen',
      description: 'Generated type manifests are missing or outdated.',
      command: 'bunx guren codegen',
    })
  }

  if (controllerFiles.length > 0) {
    steps.push({
      priority: priority++,
      title: 'Run the security audit',
      description: 'Verify validation/authentication coverage on mutating routes and scan for raw SQL and hardcoded credentials.',
      command: 'bunx guren audit',
    })
  }

  return steps
}

export function renderDoctorReport(report: DoctorReport): void {
  consola.box(`Guren doctor report for ${report.cwd}`)

  for (const check of report.checks) {
    const prefix = check.status === 'pass' ? '[ok]' : check.status === 'warn' ? '[warn]' : '[fail]'
    const log = check.status === 'pass' ? consola.success : check.status === 'warn' ? consola.warn : consola.error
    log(`${prefix} ${check.title}: ${check.message}`)

    // Several rules build one check with a ternary status and attach the same
    // options bag to both branches, so a passing check still carries the text
    // describing how to repair it. Printing that turns a clean report into a
    // wall of instructions for problems the project does not have.
    if (check.status === 'pass') {
      continue
    }

    // `fix` and `manualFix` restate each other everywhere they are both set,
    // so show one line. `manualFix` alone is the shape a few rules use.
    const remediation = check.fix ?? check.manualFix
    if (remediation) {
      consola.info(`       Fix: ${remediation}`)
    }
    if (check.canAutofix) {
      consola.info('       Autofix: available — run `guren upgrade`')
    }
  }

  if (report.recommendedCommands.length > 0) {
    console.log('')
    consola.box('Recommended commands')
    for (const command of report.recommendedCommands) {
      consola.info(command)
    }
  }

  if (report.nextSteps && report.nextSteps.length > 0) {
    console.log('')
    consola.box('Next steps')
    for (const step of report.nextSteps) {
      consola.info(`${step.priority}. ${step.title}`)
      consola.info(`   ${step.description}`)
      if (step.filePath) consola.info(`   File: ${step.filePath}`)
      if (step.command) consola.info(`   Run: ${step.command}`)
    }
  }
}

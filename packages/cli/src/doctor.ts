import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative, basename } from 'node:path'
import { consola } from 'consola'
import {
  dbArtifactPattern,
  discoverControllerFiles,
  discoverDbArtifactFiles,
  discoverModelFiles,
  discoverTestFiles,
  fileExists,
  findFirstExisting,
  hasControllerTest,
  describeControllerTestMiss,
  moduleFlagFor,
  moduleNameFor,
  readIfExists,
  classNameFromPath,
} from './discovery'
import { checkPluginCompatibility, readCoreVersion, readInstalledPluginManifests } from './plugin-manifest'
import { compareVersions } from './codemods'
import {
  describePageManifestSuppression,
  PAGES_MANIFEST_FILE,
  planPageManifest,
  type PageManifestPlan,
} from './pages-types'
import { AGENTS_MANIFEST_FILE, planAgentManifest, type AgentManifestPlan } from './agents-types'
import { emptyActions } from './controller-methods'
import { parseSourceFile } from './parse-cache'
import { resolveRoutesEntry } from './route-registrar'
import { analyzeDeployRuntime, judgeDeployRuntime } from './deploy-runtime'

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
  // Shared so every rule sees the same snapshot: computing it per-rule would
  // let concurrent rules disagree if a page file changed mid-run.
  pageManifest: Promise<PageManifestPlan>
  // Whether codegen would write `.guren/agents.gen.ts`, and whether one on disk
  // is stale (RFC 0016). Shared for the same reason, and computed once because
  // it may load the app's route graph.
  agentManifest: Promise<AgentManifestPlan>
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
const PAGE_CONTRACT_CANDIDATES = [PAGES_MANIFEST_FILE]
const GENERATED_FILES = [
  '.guren/routes.gen.ts',
  PAGES_MANIFEST_FILE,
  '.guren/data.gen.ts',
  '.guren/api-client.gen.ts',
  '.guren/channels.gen.ts',
]

/**
 * The agent manifest's rule (RFC 0016). Separate from the generic one because
 * its expectation runs both ways: codegen writes `.guren/agents.gen.ts` only
 * for apps that derive a tool and deletes it otherwise, so an existing file can
 * itself be the finding. Both findings name the same command.
 */
function createAgentManifestRule(): DoctorRule {
  const key = `generated:${AGENTS_MANIFEST_FILE}`

  return {
    key,
    title: AGENTS_MANIFEST_FILE,
    async detect(context) {
      const plan = await context.agentManifest

      if (plan.reason === 'unreadable') {
        return createCheck(
          key,
          AGENTS_MANIFEST_FILE,
          'warn',
          `Could not tell whether ${AGENTS_MANIFEST_FILE} is needed: the route graph failed to load (${plan.loadError}).`,
          {
            fix: 'Fix the route graph, then run `guren doctor` again.',
            manualFix: 'Fix the route graph, then run `guren doctor` again.',
          },
        )
      }

      if (plan.staleManifest) {
        return createCheck(
          key,
          AGENTS_MANIFEST_FILE,
          'warn',
          `${AGENTS_MANIFEST_FILE} describes agent tools this app no longer exposes — no route derives one.`,
          {
            fix: `Run \`guren codegen --force\` to remove ${AGENTS_MANIFEST_FILE}.`,
            manualFix: `Run \`guren codegen --force\` to remove ${AGENTS_MANIFEST_FILE}.`,
          },
        )
      }

      if (plan.reason === 'no-tools') {
        return createCheck(
          key,
          AGENTS_MANIFEST_FILE,
          'pass',
          `No routes declare agent metadata; ${AGENTS_MANIFEST_FILE} is not applicable.`,
        )
      }

      if (await fileExists(context.cwd, AGENTS_MANIFEST_FILE)) {
        return createCheck(
          key,
          AGENTS_MANIFEST_FILE,
          'pass',
          `Generated manifest present at ${AGENTS_MANIFEST_FILE} (${plan.toolCount} ${plan.toolCount === 1 ? 'tool' : 'tools'}).`,
        )
      }

      return createCheck(
        key,
        AGENTS_MANIFEST_FILE,
        'warn',
        `Missing generated manifest ${AGENTS_MANIFEST_FILE}.`,
        {
          fix: `Run \`guren codegen --force\` to regenerate ${AGENTS_MANIFEST_FILE}.`,
          manualFix: `Run \`guren codegen --force\` to regenerate ${AGENTS_MANIFEST_FILE}.`,
        },
      )
    },
  }
}

export const DOCTOR_RECOMMENDED_COMMANDS = [
  'bunx guren codegen --force',
  'bun run typecheck',
  'bun run build',
]

export const CANONICAL_APP_SCRIPTS = {
  dev: 'bun run codegen && bun run dev:server',
  // `dev` delegates here, so the pair has to be added together. `--hot` is what
  // makes backend edits take effect without restarting the server.
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
  // A passing check carries no remediation, whatever the caller passed: rules
  // that build one check with a ternary status hand the same options bag to
  // both branches. Enforced here so every consumer inherits it.
  if (status === 'pass') {
    return { key, title, status, message }
  }

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
  const routesFile = await resolveRoutesEntry(context.cwd)
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

/**
 * The two rules below both report on `.guren/pages.gen.ts`, and both ask
 * "would codegen regenerate it?" before "is it there?": a manifest that is
 * present *and* suppressed is what fails the typecheck. What to say about it
 * belongs to `describePageManifestSuppression`; these rules choose only the key
 * and the title.
 */
function createSuppressedPagesCheck(
  key: string,
  title: string,
  suppressed: NonNullable<ReturnType<typeof describePageManifestSuppression>>,
): DoctorCheck {
  return createCheck(key, title, 'warn', suppressed.message, { manualFix: suppressed.fix })
}

async function detectPageContracts(context: DoctorRuleContext): Promise<DoctorCheck> {
  const plan = await context.pageManifest
  const suppressed = describePageManifestSuppression(plan)

  if (suppressed) {
    return createSuppressedPagesCheck('page-contracts', 'Page Types', suppressed)
  }

  const pageContracts = await findFirstExisting(context.cwd, PAGE_CONTRACT_CANDIDATES)
  if (pageContracts) {
    return createCheck('page-contracts', 'Page Types', 'pass', `Found ${pageContracts}.`)
  }

  if (plan.reason !== 'pages') {
    return createCheck(
      'page-contracts',
      'Page Types',
      'pass',
      'No Inertia pages detected; page type generation is not applicable.',
    )
  }

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

function createGeneratedManifestRule(generatedFile: string): DoctorRule {
  const key = `generated:${generatedFile}`

  return {
    key,
    title: generatedFile,
    async detect(context) {
      const plan = generatedFile === PAGES_MANIFEST_FILE ? await context.pageManifest : null
      const suppressed = plan ? describePageManifestSuppression(plan) : null

      if (suppressed) {
        return createSuppressedPagesCheck(key, generatedFile, suppressed)
      }

      if (await fileExists(context.cwd, generatedFile)) {
        return createCheck(key, generatedFile, 'pass', `Generated manifest present at ${generatedFile}.`)
      }

      if (plan && plan.reason !== 'pages') {
        return createCheck(
          key,
          generatedFile,
          'pass',
          `No Inertia pages detected; ${generatedFile} is not applicable.`,
        )
      }


      return createCheck(
        key,
        generatedFile,
        'warn',
        `Missing generated manifest ${generatedFile}.`,
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

// Path mappings resolve relative to the tsconfig directory when `baseUrl` is
// omitted, and TypeScript 7 rejects `baseUrl` outright (TS5102), so a root
// `baseUrl` is reported as something to remove, never written.
const TSCONFIG_ALIAS_FIX = 'Set `"paths": { "@/*": ["./*"] }` in compilerOptions and remove `baseUrl` so `@/.guren/*` and `@/app/*` imports resolve on every TypeScript version.'

// Compares resolved paths rather than enumerating spellings: `.`, `./`, `''`
// and an absolute project-root path all name the same directory, and a literal
// list drops whatever it forgot into the "repoints the alias" branch. The
// `typeof` guard keeps a malformed tsconfig (`"baseUrl": 1`) a warn rather than
// a `resolve()` TypeError, and covers the omitted case in the same expression.
const isRootBaseUrl = (cwd: string, baseUrl: unknown): boolean =>
  typeof baseUrl === 'string' && resolve(cwd, baseUrl) === resolve(cwd)

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
  const baseUrlIsRoot = baseUrl === undefined || isRootBaseUrl(context.cwd, baseUrl)
  const targetsRoot = aliasTargets.some((target) => target === './*' || target === '*')
  const mapsToRoot = targetsRoot && baseUrlIsRoot
  const ok = mapsToRoot && baseUrl === undefined

  const message = ok
    ? 'tsconfig.json maps `@/*` to the project root.'
    : mapsToRoot
      ? 'tsconfig.json maps `@/*` to the project root but sets `baseUrl`, which TypeScript 7 rejects (TS5102). `paths` resolves from the tsconfig directory without it.'
      : aliasTargets.length === 0
        ? 'tsconfig.json does not define the `@/*` path alias.'
        : !targetsRoot
          ? `tsconfig.json maps \`@/*\` to ${JSON.stringify(aliasTargets)} instead of the project root (\`["./*"]\`). Scaffolded code imports \`@/.guren/*\` and \`@/app/*\` relative to the project root; adjust existing \`@/\` imports when changing the mapping.`
          : `tsconfig.json maps \`@/*\` to \`["./*"]\` but \`baseUrl\` is ${JSON.stringify(baseUrl)}, so the alias resolves under that directory instead of the project root.`

  return createCheck('tsconfig-alias', 'Path Alias', ok ? 'pass' : 'warn', message, {
    fix: TSCONFIG_ALIAS_FIX,
    manualFix: TSCONFIG_ALIAS_FIX,
    // Rewriting a mapping that points elsewhere could break imports relying on
    // the old resolution. Dropping a root baseUrl changes nothing: `paths`
    // resolves from the same directory.
    canAutofix: baseUrlIsRoot && (aliasTargets.length === 0 || targetsRoot),
  })
}

async function createTsconfigAliasAutofix(_context: DoctorRuleContext, check: DoctorCheck): Promise<DoctorAutofix | null> {
  if (check.status === 'pass' || !check.canAutofix) {
    return null
  }

  return {
    key: check.key,
    title: check.title,
    summary: 'Add `"paths": { "@/*": ["./*"] }` to tsconfig.json and remove a root `baseUrl`.',
    async apply(cwd: string) {
      const current = await readJsonIfExists<TsconfigShape>(cwd, 'tsconfig.json')
      if (!current.exists || current.parseError || !current.value) {
        return
      }

      const nextConfig = { ...current.value }
      const compilerOptions = { ...nextConfig.compilerOptions }
      if (isRootBaseUrl(cwd, compilerOptions.baseUrl)) {
        delete compilerOptions.baseUrl
      }
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
      const scripts = { ...nextManifest.scripts }
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

async function detectBunVersion(_context: DoctorRuleContext): Promise<DoctorCheck> {
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

  const hasRoutesImport = combinedSource.includes('routes') && (
    combinedSource.includes("from 'routes/") ||
    combinedSource.includes("from '@/routes/") ||
    combinedSource.includes("from '../routes/") ||
    combinedSource.includes("from './routes/") ||
    combinedSource.includes('routes:') ||
    combinedSource.includes('routes,')
  )
  const routeFileExists = await resolveRoutesEntry(context.cwd)

  if (routeFileExists && !hasRoutesImport) {
    issues.push('Route file exists but may not be wired into createApp()')
  }

  const hasProviders = combinedSource.includes('providers')
  const providerDir = await fileExists(context.cwd, 'app/Providers')
  if (providerDir && !hasProviders) {
    issues.push('Providers directory exists but may not be wired into createApp()')
  }

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

// Twinned with `DATABASE_CONFIG_CANDIDATES` in @guren/core's deploy-build,
// which the deploy plugins read to find out which database an app declares.
// A location added here has to be added there too, or a build stubs the
// clients of an app whose config this check calls fine.
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
 * Whether the project has any test foundation: `@guren/testing` installed, or
 * at least one test file under `tests/`. Older scaffolds and hand-rolled
 * projects can have neither.
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
  createAgentManifestRule(),
  { key: 'tsconfig', title: 'TypeScript Config', detect: detectTsconfig, autofix: createTsconfigAutofix },
  { key: 'tsconfig-alias', title: 'Path Alias', detect: detectTsconfigAlias, autofix: createTsconfigAliasAutofix },
  { key: 'bootstrap', title: 'Bootstrap Style', detect: detectBootstrap },
  { key: 'config-drift', title: 'App Wiring', detect: detectConfigDrift },
  { key: 'scripts', title: 'App Scripts', detect: detectScripts, autofix: createScriptsAutofix },
  { key: 'database-config', title: 'Database Configuration', detect: detectDatabaseConfig },
  { key: 'test-infrastructure', title: 'Test Infrastructure', detect: detectTestInfrastructure },
  { key: 'plugin-compatibility', title: 'Plugin Compatibility', detect: detectPluginCompatibility },
]

/**
 * The manifest plans a doctor run needs, started once and awaited wherever used.
 * Both are expensive (the agent plan may evaluate the app's whole module graph)
 * and both are asked for twice in a `--next` run, by the rules and by the
 * next-step suggestions. Promises rather than awaited values, so a run that
 * never reaches a consumer never pays for one.
 */
export interface DoctorManifestPlans {
  pageManifest: Promise<PageManifestPlan>
  agentManifest: Promise<AgentManifestPlan>
}

function createManifestPlans(cwd: string): DoctorManifestPlans {
  return { pageManifest: planPageManifest(cwd), agentManifest: planAgentManifest(cwd) }
}

export async function getDoctorRuleEvaluations(
  options: { cwd?: string } = {},
  plans?: DoctorManifestPlans,
): Promise<{
  cwd: string
  evaluations: DoctorRuleEvaluation[]
}> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const context: DoctorRuleContext = { cwd, ...(plans ?? createManifestPlans(cwd)) }

  // The deploy-runtime checks share one filesystem scan, computed here rather
  // than through the DoctorRule interface: they need no autofix and no context
  // beyond cwd.
  const [ruleEvaluations, deployAnalysis] = await Promise.all([
    Promise.all(
      doctorRules.map(async (rule) => {
        const check = await rule.detect(context)
        const autofix = rule.autofix && check.status !== 'pass'
          ? await rule.autofix(context, check)
          : null
        return { check, autofix } as DoctorRuleEvaluation
      }),
    ),
    analyzeDeployRuntime(cwd),
  ])

  // The verdicts are shared with `guren check` and the deploy builds
  // (RFC 0020 Part 0); doctor's only addition is the remediation pair.
  const deployEvaluations: DoctorRuleEvaluation[] = judgeDeployRuntime(deployAnalysis).map((verdict) => ({
    check: createCheck(verdict.key, verdict.title, verdict.status, verdict.message, {
      fix: verdict.fix,
      manualFix: verdict.fix,
    }),
    autofix: null,
  }))

  return { cwd, evaluations: [...ruleEvaluations, ...deployEvaluations] }
}

export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  // One memo for the whole run: the rules and `--next` both read these plans,
  // and the agent one can evaluate the app's module graph.
  const plans = createManifestPlans(resolve(options.cwd ?? process.cwd()))
  const { cwd, evaluations } = await getDoctorRuleEvaluations({ cwd: options.cwd }, plans)
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
    report.nextSteps = await suggestNextSteps({ cwd }, plans)
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

export async function suggestNextSteps(
  options: { cwd?: string } = {},
  plans?: DoctorManifestPlans,
): Promise<NextStep[]> {
  const cwd = resolve(options.cwd ?? process.cwd())
  // Optional so a standalone caller (the MCP tool) still works; supplied by
  // `runDoctor`, where the rules have already started these.
  const manifestPlans = plans ?? createManifestPlans(cwd)
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
      const ast = parseSourceFile(source, filePath)
      if (!ast) continue

      for (const { className, name } of emptyActions(ast, filePath)) {
        steps.push({
          priority: priority++,
          title: `Implement ${className}.${name}()`,
          description: 'Method has an empty body.',
          filePath: relative(cwd, filePath),
        })
      }
    }
  } catch {
    // Ignore unreadable files; parseSourceFile returns null rather than throwing.
  }

  try {
    for (const filePath of controllerFiles) {
      const name = classNameFromPath(filePath)
      if (!(await hasControllerTest(cwd, filePath))) {
        const moduleFlag = moduleFlagFor(cwd, filePath)
        steps.push({
          priority: priority++,
          // Titled as a question, not an action: detection is by filename, so a
          // consumer reading only the title would otherwise duplicate a test
          // that exists under another name.
          title: `Confirm test coverage for ${name}`,
          description: `${describeControllerTestMiss(cwd, filePath)} Check whether these routes are already covered under another name before adding a test.`,
          command: `bunx guren make:test ${name.replace('Controller', '')} --controller${moduleFlag}`,
        })
      }
    }
  } catch {
    // Ignore
  }

  try {
    const modelFiles = await discoverModelFiles(cwd)
    // Matched by `dbArtifactPattern`, not by exact path: `make:factory` appends
    // its suffix to whatever the user typed, so probing `<Name>Factory.ts` told
    // a user who already had `CategoriesFactory.ts` to scaffold a second one.
    // Grouped by app root, the same scoping `guren context <Entity>` applies.
    const factoryNamesByModule = new Map<string | null, string[]>()
    for (const file of await discoverDbArtifactFiles(cwd, 'Factory')) {
      const key = moduleNameFor(cwd, file)
      factoryNamesByModule.set(key, [...(factoryNamesByModule.get(key) ?? []), basename(file)])
    }

    for (const filePath of modelFiles) {
      const name = classNameFromPath(filePath)
      const factoryPattern = dbArtifactPattern(name, 'Factory')
      const factoryNames = factoryNamesByModule.get(moduleNameFor(cwd, filePath)) ?? []
      if (!factoryNames.some((factoryName) => factoryPattern.test(factoryName))) {
        steps.push({
          priority: priority++,
          title: `Add factory for ${name}`,
          description: 'No factory file found for testing and seeding.',
          command: `bunx guren make:factory ${name}${moduleFlagFor(cwd, filePath)}`,
        })
      }
    }
  } catch {
    // Ignore
  }

  const [pagesPlan, agentPlan] = await Promise.all([manifestPlans.pageManifest, manifestPlans.agentManifest])
  const requiredManifests = [
    '.guren/routes.gen.ts',
    ...(pagesPlan.reason === 'pages' ? [PAGES_MANIFEST_FILE] : []),
    '.guren/data.gen.ts',
    // Conditional on the derivation rather than on a route file mentioning
    // `.agent()`: an app that derives no tool is not missing a manifest.
    ...(agentPlan.reason === 'tools' ? [AGENTS_MANIFEST_FILE] : []),
    '.guren/api-client.gen.ts',
  ]
  // A stale agent manifest is the same next step: codegen removes it.
  let missingManifests = agentPlan.staleManifest
  for (const manifest of requiredManifests) {
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

    if (check.status === 'pass') {
      continue
    }

    // Some rules set both fields to the same string; others put a required
    // extra step in `manualFix`. Dedupe, then the first line is the fix and any
    // second is the step it does not cover.
    const steps = [...new Set([check.fix, check.manualFix].filter((step): step is string => Boolean(step)))]
    for (const [index, step] of steps.entries()) {
      consola.info(`       ${index === 0 ? 'Fix' : 'Manual'}: ${step}`)
    }
    if (check.canAutofix) {
      // Not an instruction: `guren upgrade` also realigns every @guren/*
      // dependency, which is more than someone chasing one check asked for.
      consola.info('       Autofix: available — applied by `guren upgrade`')
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

import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { consola } from 'consola'

export type DoctorStatus = 'pass' | 'warn' | 'fail'

export interface DoctorCheck {
  key: string
  title: string
  status: DoctorStatus
  message: string
  fix?: string
}

export interface DoctorReport {
  cwd: string
  checks: DoctorCheck[]
  hasWarnings: boolean
  hasFailures: boolean
}

export interface RunDoctorOptions {
  cwd?: string
  json?: boolean
}

const APP_ENTRY_CANDIDATES = ['src/main.ts', 'src/main.mts', 'src/main.js', 'src/main.mjs']
const ROUTE_CANDIDATES = ['routes/web.ts', 'routes/web.js', 'routes/api.ts', 'routes/api.js']
const PAGE_CONTRACT_CANDIDATES = [
  'resources/js/pages/contracts.ts',
  'resources/js/pages/contracts.tsx',
  'resources/js/pages/contracts.js',
  'resources/js/pages/contracts.jsx',
]
const GENERATED_FILES = ['.guren/routes.gen.ts', '.guren/pages.gen.ts', '.guren/data.gen.ts', '.guren/channels.gen.ts']

async function fileExists(cwd: string, relativePath: string): Promise<boolean> {
  try {
    await access(resolve(cwd, relativePath))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function findFirstExisting(cwd: string, candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await fileExists(cwd, candidate)) {
      return candidate
    }
  }

  return null
}

async function readIfExists(cwd: string, relativePath: string): Promise<string | null> {
  if (!(await fileExists(cwd, relativePath))) {
    return null
  }

  return readFile(resolve(cwd, relativePath), 'utf8')
}

function createCheck(
  key: string,
  title: string,
  status: DoctorStatus,
  message: string,
  fix?: string,
): DoctorCheck {
  return { key, title, status, message, fix }
}

export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const checks: DoctorCheck[] = []

  const packageJsonRaw = await readIfExists(cwd, 'package.json')
  if (!packageJsonRaw) {
    checks.push(
      createCheck(
        'package-json',
        'package.json',
        'fail',
        'No package.json was found in the current workspace.',
        'Create a Guren app root or run `guren new` in an empty directory.',
      ),
    )
  } else {
    checks.push(createCheck('package-json', 'package.json', 'pass', 'Workspace package.json detected.'))
  }

  const appEntry = await findFirstExisting(cwd, APP_ENTRY_CANDIDATES)
  if (!appEntry) {
    checks.push(
      createCheck(
        'app-entry',
        'Application Entry',
        'fail',
        'Could not find an application entry point in src/main.{ts,js,mts,mjs}.',
        'Add src/main.ts and export a bootable application.',
      ),
    )
  } else {
    checks.push(createCheck('app-entry', 'Application Entry', 'pass', `Found ${appEntry}.`))
  }

  const routesFile = await findFirstExisting(cwd, ROUTE_CANDIDATES)
  if (!routesFile) {
    checks.push(
      createCheck(
        'routes',
        'Route Sources',
        'fail',
        'No routes/web.ts or routes/api.ts file was found.',
        'Add a route registrar and pass it into createApp({ routes }).',
      ),
    )
  } else {
    checks.push(createCheck('routes', 'Route Sources', 'pass', `Found ${routesFile}.`))
  }

  const pageContracts = await findFirstExisting(cwd, PAGE_CONTRACT_CANDIDATES)
  if (!pageContracts) {
    checks.push(
      createCheck(
        'page-contracts',
        'Page Contracts',
        'warn',
        'No resources/js/pages/contracts.* file was found.',
        'Define pages with definePage() so controllers and components share the same contract.',
      ),
    )
  } else {
    checks.push(createCheck('page-contracts', 'Page Contracts', 'pass', `Found ${pageContracts}.`))
  }

  for (const generatedFile of GENERATED_FILES) {
    checks.push(
      createCheck(
        `generated:${generatedFile}`,
        generatedFile,
        (await fileExists(cwd, generatedFile)) ? 'pass' : 'warn',
        (await fileExists(cwd, generatedFile))
          ? `Generated manifest present at ${generatedFile}.`
          : `Missing generated manifest ${generatedFile}.`,
        `Run \`guren codegen --force\` to regenerate ${generatedFile}.`,
      ),
    )
  }

  const tsconfigRaw = await readIfExists(cwd, 'tsconfig.json')
  if (!tsconfigRaw) {
    checks.push(
      createCheck(
        'tsconfig',
        'TypeScript Config',
        'warn',
        'No tsconfig.json was found.',
        'Add tsconfig.json and include `.guren/**/*` so generated contracts are type-checked.',
      ),
    )
  } else {
    const includesGenerated = tsconfigRaw.includes('.guren')
    checks.push(
      createCheck(
        'tsconfig',
        'TypeScript Config',
        includesGenerated ? 'pass' : 'warn',
        includesGenerated
          ? 'tsconfig.json includes generated .guren artifacts.'
          : 'tsconfig.json does not appear to include generated .guren artifacts.',
        'Add `.guren/**/*` to the tsconfig include list.',
      ),
    )
  }

  if (appEntry) {
    const appEntryRaw = await readIfExists(cwd, appEntry)
    const appSourceCandidates = [appEntryRaw]

    if (await fileExists(cwd, 'src/app.ts')) {
      appSourceCandidates.push(await readIfExists(cwd, 'src/app.ts'))
    }

    const combinedSource = appSourceCandidates.filter((value): value is string => typeof value === 'string').join('\n')
    const usesCreateApp = combinedSource.includes('createApp(')
    const usesLegacyApplication = combinedSource.includes('new Application(')

    checks.push(
      createCheck(
        'bootstrap',
        'Bootstrap Style',
        usesCreateApp ? 'pass' : usesLegacyApplication ? 'warn' : 'warn',
        usesCreateApp
          ? 'Application bootstrap uses createApp().'
          : usesLegacyApplication
            ? 'Application bootstrap still uses new Application().'
            : 'Could not detect createApp() in the application bootstrap.',
        'Prefer `createApp({ routes, providers, features })` over side-effect bootstrapping.',
      ),
    )
  }

  if (packageJsonRaw) {
    const packageJson = JSON.parse(packageJsonRaw) as { scripts?: Record<string, string> }
    const scripts = packageJson.scripts ?? {}
    const expectedScripts = ['dev', 'build', 'typecheck', 'codegen']
    const missingScripts = expectedScripts.filter((script) => !(script in scripts))

    checks.push(
      createCheck(
        'scripts',
        'App Scripts',
        missingScripts.length === 0 ? 'pass' : 'warn',
        missingScripts.length === 0
          ? 'package.json exposes dev/build/typecheck/codegen scripts.'
          : `package.json is missing recommended scripts: ${missingScripts.join(', ')}.`,
        'Add `dev`, `build`, `typecheck`, and `codegen` scripts to package.json.',
      ),
    )
  }

  const report: DoctorReport = {
    cwd,
    checks,
    hasWarnings: checks.some((check) => check.status === 'warn'),
    hasFailures: checks.some((check) => check.status === 'fail'),
  }

  if (!options.json) {
    renderDoctorReport(report)
  }

  return report
}

export function renderDoctorReport(report: DoctorReport): void {
  consola.box(`Guren doctor report for ${report.cwd}`)

  for (const check of report.checks) {
    const prefix = check.status === 'pass' ? '[ok]' : check.status === 'warn' ? '[warn]' : '[fail]'
    const log = check.status === 'pass' ? consola.success : check.status === 'warn' ? consola.warn : consola.error
    log(`${prefix} ${check.title}: ${check.message}`)
    if (check.fix) {
      consola.info(`       Fix: ${check.fix}`)
    }
  }
}

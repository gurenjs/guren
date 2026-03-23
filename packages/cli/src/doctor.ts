import { access, readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { consola } from 'consola'
import { discoverControllerFiles, discoverModelFiles, fileExists as discoveryFileExists, classNameFromPath } from './discovery'
import { parseModelFile } from './model-parser'

export type DoctorStatus = 'pass' | 'warn' | 'fail'

export interface DoctorCheck {
  key: string
  title: string
  status: DoctorStatus
  message: string
  fix?: string
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
  hasWarnings: boolean
  hasFailures: boolean
  nextSteps?: NextStep[]
}

export interface RunDoctorOptions {
  cwd?: string
  json?: boolean
  next?: boolean
}

const APP_ENTRY_CANDIDATES = ['src/main.ts', 'src/main.mts', 'src/main.js', 'src/main.mjs']
const ROUTE_CANDIDATES = ['routes/web.ts', 'routes/web.js', 'routes/api.ts', 'routes/api.js']
const PAGE_CONTRACT_CANDIDATES = [
  '.guren/pages.gen.ts',
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
        'Page Types',
        'warn',
        'No .guren/pages.gen.ts file was found.',
        'Run `bunx guren routes:types` to generate page type definitions.',
      ),
    )
  } else {
    checks.push(createCheck('page-contracts', 'Page Types', 'pass', `Found ${pageContracts}.`))
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

  if (options.next) {
    report.nextSteps = await suggestNextSteps({ cwd })
  }

  if (!options.json) {
    renderDoctorReport(report)
  }

  return report
}

export async function suggestNextSteps(options: { cwd?: string } = {}): Promise<NextStep[]> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const steps: NextStep[] = []
  let priority = 1

  // 1. Check for empty controller methods
  try {
    const controllerFiles = await discoverControllerFiles(cwd)
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
              description: `Method has an empty body.`,
              filePath: relative(cwd, filePath),
            })
          }
        }
      }
    }
  } catch {
    // Ignore discovery failures
  }

  // 2. Check for missing test files
  try {
    const controllerFiles = await discoverControllerFiles(cwd)
    for (const filePath of controllerFiles) {
      const name = classNameFromPath(filePath)
      const testCandidates = [
        `tests/controllers/${name}.test.ts`,
        `tests/${name}.test.ts`,
      ]
      let hasTest = false
      for (const candidate of testCandidates) {
        if (await discoveryFileExists(cwd, candidate)) {
          hasTest = true
          break
        }
      }
      if (!hasTest) {
        steps.push({
          priority: priority++,
          title: `Add tests for ${name}`,
          description: `No test file found.`,
          command: `bunx guren make:test ${name.replace('Controller', '')} --controller`,
        })
      }
    }
  } catch {
    // Ignore
  }

  // 3. Check for models without factories
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
        if (await discoveryFileExists(cwd, candidate)) {
          hasFactory = true
          break
        }
      }
      if (!hasFactory) {
        steps.push({
          priority: priority++,
          title: `Add factory for ${name}`,
          description: `No factory file found for testing and seeding.`,
          command: `bunx guren make:factory ${name}`,
        })
      }
    }
  } catch {
    // Ignore
  }

  // 4. Check for missing codegen
  const manifests = ['.guren/routes.gen.ts', '.guren/pages.gen.ts', '.guren/data.gen.ts']
  let missingManifests = false
  for (const manifest of manifests) {
    if (!(await discoveryFileExists(cwd, manifest))) {
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

  return steps
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

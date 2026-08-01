import { resolve, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import { consola } from 'consola'
import {
  discoverControllerFiles,
  discoverModelFiles,
  fileExists,
  hasControllerTest,
  describeControllerTestMiss,
  classNameFromPath,
  toPosixRelative,
  listModuleNames,
  moduleNameFor,
  formatTruncatedList,
} from './discovery'
import {
  classUsesAuthenticatableBase,
  extractClassDeclaration,
  findStaticClassProperty,
  staticStringArrayProperty,
  staticStringProperty,
} from './model-parser'
import { checkConsoleCommandRegistration } from './console-check'
import { tableNameFor } from './inflect'
import { checkSchemaTimestamps } from './schema-check'
import { schemaPathFor } from './schema-parser'
import { ParseCache } from './parse-cache'
import { extractInertiaPageRefs, resolveInertiaPageFile, expectedInertiaPagePath } from './inertia-pages'
import { appEmitsPageManifest } from './pages-types'
import { runArchCheck } from './arch-check'
import { runDocsCheck } from './docs-check'
import { runSpecCheck } from './spec-check'
import { getChangedFiles } from './changed-files'
import { check, type CheckResult, type CheckReport, type CheckStatus } from './check-result'

export type { CheckStatus, CheckResult, CheckReport }

export interface RunCheckOptions {
  cwd?: string
  json?: boolean
  routesFile?: string
  /**
   * Run architecture boundary checks only (`guren.arch.ts` + derived module
   * rules), skipping the route/controller/page/manifest checks below. Fast
   * path for the agent-harness edit hook.
   */
  arch?: boolean
  /**
   * Restrict file-scanning checks (empty methods, arch boundaries) to files
   * changed vs. the merge base with main, plus uncommitted/untracked files.
   * Falls back to checking everything when not in a git repo.
   */
  changed?: boolean
  /**
   * Run doc-link checks only (docs/ frontmatter + @docs tags), skipping
   * everything else. Like `--arch`, a brand-new fast path that gates on
   * exit code from day one.
   */
  docs?: boolean
  /** Run spec drift checks only (docs/spec/ vs regenerated views). */
  spec?: boolean
}

/**
 * Verifies every `modules/<name>/db/schema.ts` is re-exported from the
 * project's root `db/schema.ts` — the wiring `make:module` performs
 * automatically (RFC 0002). A module without a `db/schema.ts` is skipped
 * (nothing to aggregate); a project without a root `db/schema.ts` warns
 * rather than failing, since not every app uses a database.
 */
async function checkModuleSchemaAggregation(cwd: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const moduleNames = await listModuleNames(cwd)

  for (const moduleName of moduleNames) {
    const moduleSchemaPath = `modules/${moduleName}/db/schema.ts`
    if (!(await fileExists(cwd, moduleSchemaPath))) continue

    const rootSchemaPath = 'db/schema.ts'
    if (!(await fileExists(cwd, rootSchemaPath))) {
      results.push(
        check(
          `module-schema-aggregation:${moduleName}`,
          `${moduleName} schema aggregation`,
          'warn',
          `${moduleSchemaPath} exists but there is no root ${rootSchemaPath} to re-export it from.`,
          `Create ${rootSchemaPath} and add: export * from '../modules/${moduleName}/db/schema'`,
        ),
      )
      continue
    }

    const rootSchemaContent = await readFile(resolve(cwd, rootSchemaPath), 'utf-8')
    // Substring match, tolerant of quote style and a trailing .js/.ts extension.
    const isReExported = rootSchemaContent.includes(`modules/${moduleName}/db/schema`)

    results.push(
      check(
        `module-schema-aggregation:${moduleName}`,
        `${moduleName} schema aggregation`,
        isReExported ? 'pass' : 'warn',
        isReExported
          ? `${rootSchemaPath} re-exports ${moduleSchemaPath}.`
          : `${rootSchemaPath} does not re-export ${moduleSchemaPath}.`,
        isReExported ? undefined : `Add to ${rootSchemaPath}: export * from '../modules/${moduleName}/db/schema'`,
      ),
    )
  }

  return results
}

export async function runCheck(options: RunCheckOptions = {}): Promise<CheckReport> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const checks: CheckResult[] = []
  const cache = new ParseCache()

  const changedFiles = options.changed ? await getChangedFiles(cwd) : null
  const filterChanged = (files: string[]): string[] =>
    changedFiles ? files.filter((f) => changedFiles.has(toPosixRelative(cwd, f))) : files

  // `--arch` / `--docs` / `--spec` select suites; combining them runs the
  // union (never silently nothing). No flag = every suite.
  const selected = new Set<'arch' | 'docs' | 'spec'>([
    ...(options.arch ? (['arch'] as const) : []),
    ...(options.docs ? (['docs'] as const) : []),
    ...(options.spec ? (['spec'] as const) : []),
  ])
  const runs = (suite: 'core' | 'arch' | 'docs' | 'spec'): boolean =>
    selected.size === 0 || (suite !== 'core' && selected.has(suite))

  if (runs('core')) {
    // 1. Check controllers for empty methods
    const controllerFiles = filterChanged(await discoverControllerFiles(cwd))
    for (const filePath of controllerFiles) {
      const relPath = relative(cwd, filePath)
      const results = await checkEmptyMethods(cache, filePath, relPath)
      checks.push(...results)
    }

    // 2. Check controllers reference existing pages
    for (const filePath of controllerFiles) {
      const relPath = relative(cwd, filePath)
      const results = await checkInertiaPages(cache, filePath, cwd, relPath)
      checks.push(...results)
    }

    // 3. Check models have migrations
    const modelFiles = filterChanged(await discoverModelFiles(cwd))
    for (const filePath of modelFiles) {
      const relPath = relative(cwd, filePath)
      const name = classNameFromPath(filePath)
      checks.push(...(await checkMassAssignmentConfig(cache, filePath, name, relPath)))
      const moduleName = moduleNameFor(cwd, filePath)
      const schemaPath = schemaPathFor(moduleName)
      const hasSchema = await fileExists(cwd, schemaPath)
      if (hasSchema) {
        const schemaContent = await readFile(resolve(cwd, schemaPath), 'utf-8')
        const tableName = tableNameFor(name)
        const hasTable = schemaContent.includes(`'${tableName}'`) || schemaContent.includes(`"${tableName}"`)
        checks.push(
          check(
            `model-schema:${name}`,
            `${name} schema`,
            hasTable ? 'pass' : 'warn',
            hasTable ? `Table definition found for ${name}.` : `No table '${tableName}' found in ${schemaPath}.`,
            hasTable ? undefined : `Add table definition to ${schemaPath} for ${name}.`,
            relPath,
          ),
        )
      }
    }

    // 4. Check missing test files for controllers
    for (const filePath of controllerFiles) {
      const name = classNameFromPath(filePath)
      const moduleName = moduleNameFor(cwd, filePath)
      const hasTest = await hasControllerTest(cwd, filePath)
      const moduleFlag = moduleName ? ` --module ${moduleName}` : ''
      const message = hasTest
        ? `Test file found for ${name}.`
        : describeControllerTestMiss(cwd, filePath)
      const suggestion = hasTest
        ? undefined
        : `If these routes are not already covered, run: bunx guren make:test ${name.replace('Controller', '')} --controller${moduleFlag}`
      // Advisory: a missing test is advice, not an integrity failure, so
      // exit-code gates (check --ci) must not fail on it.
      checks.push({ ...check(`test:${name}`, `${name} tests`, hasTest ? 'pass' : 'warn', message, suggestion), advisory: true })
    }

    // 5. Check generated manifests are present. The pages manifest only
    // exists for apps with Inertia pages — codegen never emits it in an
    // API-only app, so demanding it there is a false positive.
    const hasPages = await appEmitsPageManifest(cwd)
    const manifests = [
      '.guren/routes.gen.ts',
      ...(hasPages ? ['.guren/pages.gen.ts'] : []),
      '.guren/data.gen.ts',
    ]
    for (const manifest of manifests) {
      const exists = await fileExists(cwd, manifest)
      checks.push(
        check(
          `manifest:${manifest}`,
          manifest,
          exists ? 'pass' : 'warn',
          exists ? `${manifest} is present.` : `${manifest} is missing.`,
          exists ? undefined : 'Run: bunx guren codegen',
        ),
      )
    }

    // 6. Check every module's db/schema.ts is re-exported from the root
    // db/schema.ts (the wiring make:module performs automatically — this
    // catches modules created or edited by hand). Not an architecture
    // boundary rule, so it stays out of `--arch`'s fast path alongside
    // checks 1-5.
    const schemaAggregationResults = await checkModuleSchemaAggregation(cwd)
    checks.push(...schemaAggregationResults)

    // 7. Check every console command is registered with a kernel (the wiring
    // make:command performs automatically — this catches commands written or
    // moved by hand). Content-activated: apps with no app/Console/Commands
    // contribute nothing here.
    const commandRegistrationResults = await checkConsoleCommandRegistration(cwd, cache)
    checks.push(...commandRegistrationResults)

    // 8. Check Postgres timestamp columns carry a time zone. Content-activated
    // and dialect-gated: apps with no schema, or a non-Postgres one, contribute
    // nothing. Not changed-filtered, like checks 6-7 — the schema is a handful
    // of files, so narrowing would hide a column an unrelated edit never
    // touched.
    const schemaTimestampResults = await checkSchemaTimestamps(cwd)
    checks.push(...schemaTimestampResults)
  }

  // 9. Doc-link checks (docs/ frontmatter + @docs tags, RFC 0004). Runs in
  // plain mode and under --docs; content-activated, so apps without the
  // docs convention contribute zero results here.
  if (runs('docs')) {
    const docsResults = await runDocsCheck({ cwd, changedFiles, cache })
    checks.push(...docsResults)
  }

  // 10. Spec drift checks (docs/spec/ vs regenerated views, RFC 0004).
  // Content-activated like docs; under --changed it only regenerates when
  // a spec-relevant file changed.
  if (runs('spec')) {
    const specResults = await runSpecCheck({ cwd, routesFile: options.routesFile, changedFiles })
    checks.push(...specResults)
  }

  // 11. Check architecture boundaries (guren.arch.ts + derived module rules)
  if (runs('arch')) {
    const archResults = await runArchCheck({ cwd, cache, changedFiles })
    checks.push(...archResults)
  }

  // Every checker above treats a file it couldn't parse as contributing
  // nothing, which is indistinguishable from a file with nothing wrong. Report
  // the skipped ones once, after all suites have finished asking the cache, so
  // a clean run over an incomplete scan says so instead of implying coverage.
  const skipped = cache.skippedFiles()
  if (skipped.length > 0) {
    const shown = formatTruncatedList(
      skipped.map(({ filePath, reason }) => `${toPosixRelative(cwd, filePath)} (${reason})`),
    )
    checks.push(
      check(
        'scan-coverage',
        'Scan coverage',
        'warn',
        `${skipped.length} file(s) were skipped and not checked: ${shown}.`,
        'Fix the syntax error (or file permissions) so these files are covered — until then results here are incomplete.',
      ),
    )
  }

  const report: CheckReport = {
    cwd,
    checks,
    passCount: checks.filter((c) => c.status === 'pass').length,
    warnCount: checks.filter((c) => c.status === 'warn').length,
    failCount: checks.filter((c) => c.status === 'fail').length,
  }

  return report
}

/**
 * Mass-assignment definition checks (AST-based via the shared ParseCache, so
 * comments, access modifiers, and type annotations neither hide a declaration
 * nor fake one).
 *
 * `guarded` and `strictFillable` no longer exist as Model API — a model
 * declaring them ships dead-looking protection that TypeScript accepts
 * silently (agents reproducing older patterns are the likely authors), so
 * the declaration itself is an error, not a warning.
 *
 * A fillable list naming a denied credential column is a contradiction that
 * otherwise only surfaces at the first write: the field throws regardless.
 * The denied set's inputs are parseable statics (passwordHashField /
 * rememberTokenField, defaulting to passwordHash / rememberToken), so it is
 * resolved here the same way the model resolves it at runtime.
 */
async function checkMassAssignmentConfig(
  cache: ParseCache,
  filePath: string,
  name: string,
  relPath: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const parsed = await cache.get(filePath)
  if (!parsed) return results

  let classDecl = null
  for (const node of parsed.ast.program.body) {
    classDecl = extractClassDeclaration(node)
    if (classDecl) break
  }
  if (!classDecl) return results

  const legacy = ['guarded', 'strictFillable'].filter((property) => findStaticClassProperty(classDecl!, property))
  if (legacy.length > 0) {
    results.push(
      check(
        `mass-assignment-legacy:${name}`,
        `${name} legacy mass-assignment config`,
        'fail',
        `${name} declares ${legacy.join(' and ')}, which no longer exist as Model API — the declaration is inert.`,
        `Delete the ${legacy.join('/')} declaration. The primary key and credential columns are protected by `
        + `the framework; any OTHER field the old guarded list carried (e.g. tenantId, isAdmin) is now `
        + `mass-assignable — declare 'static fillable = [...]' without those fields to keep them protected.`,
        relPath,
      ),
    )
  }

  if (classUsesAuthenticatableBase(classDecl)) {
    const fillable = staticStringArrayProperty(classDecl, 'fillable')
    if (fillable) {
      const passwordField = staticStringProperty(classDecl, 'passwordField') ?? 'password'
      const hashField = staticStringProperty(classDecl, 'passwordHashField') ?? 'passwordHash'
      const rememberField = staticStringProperty(classDecl, 'rememberTokenField') ?? 'rememberToken'
      const denied = [...(hashField !== passwordField ? [hashField] : []), rememberField]
      const contradictions = fillable.filter((field) => denied.includes(field))
      if (contradictions.length > 0) {
        results.push(
          check(
            `mass-assignment-denied:${name}`,
            `${name} fillable lists denied columns`,
            'fail',
            `${name} lists ${contradictions.map((f) => `'${f}'`).join(', ')} in fillable, but credential columns `
            + `can never be mass-assigned — every create()/update() carrying them will throw.`,
            `Remove ${contradictions.map((f) => `'${f}'`).join(', ')} from fillable. Pass a plain password and let `
            + `the model hash it, or use forceCreate()/forceUpdate() for trusted server-side values.`,
            relPath,
          ),
        )
      }
    }
  }

  return results
}

async function checkEmptyMethods(cache: ParseCache, filePath: string, relPath: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const parsed = await cache.get(filePath)
  if (!parsed) return results
  const { ast } = parsed

  for (const node of ast.program.body) {
    const classDecl = extractClassDeclaration(node)
    if (!classDecl) continue
    const className = classDecl.id?.name ?? classNameFromPath(filePath)

    for (const member of classDecl.body.body) {
      if (member.type === 'ClassMethod' && member.key.type === 'Identifier') {
        if (member.key.name === 'constructor') continue
        const body = member.body
        const isEmpty = body.body.length === 0
        if (isEmpty) {
          results.push(
            check(
              `empty-method:${className}.${member.key.name}`,
              `${className}.${member.key.name}()`,
              'warn',
              `Method ${member.key.name}() has an empty body.`,
              `Implement ${className}.${member.key.name}() in ${relPath}.`,
              relPath,
            ),
          )
        }
      }
    }
  }

  return results
}

async function checkInertiaPages(
  cache: ParseCache,
  filePath: string,
  cwd: string,
  relPath: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  // A syntax error doesn't invalidate this regex-only scan, so it asks the
  // cache for source rather than an AST — the file is read once either way.
  const source = await cache.source(filePath)
  if (source === null) return results

  for (const ref of extractInertiaPageRefs(source)) {
    if (ref.form === 'manifest') continue // pages.xxx pattern — already type-checked

    const pageFile = await resolveInertiaPageFile(cwd, ref.id)
    if (!pageFile) {
      results.push(
        check(
          `page:${ref.id}`,
          `Page ${ref.id}`,
          'fail',
          `Controller references page '${ref.id}' but no file found.`,
          `Create: ${expectedInertiaPagePath(ref.id)}`,
          relPath,
        ),
      )
    }
  }

  return results
}

export function renderCheckReport(report: CheckReport): void {
  consola.box(`Guren integrity check for ${report.cwd}`)

  for (const c of report.checks) {
    const prefix = c.status === 'pass' ? '[ok]' : c.status === 'warn' ? '[warn]' : '[fail]'
    const log = c.status === 'pass' ? consola.success : c.status === 'warn' ? consola.warn : consola.error
    log(`${prefix} ${c.title}: ${c.message}`)
    if (c.suggestion) {
      consola.info(`       → ${c.suggestion}`)
    }
  }

  console.log('')
  console.log(`Results: ${report.passCount} passed, ${report.warnCount} warnings, ${report.failCount} failures`)
}

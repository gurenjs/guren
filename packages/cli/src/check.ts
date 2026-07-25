import { resolve, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import { consola } from 'consola'
import {
  discoverControllerFiles,
  discoverModelFiles,
  fileExists,
  classNameFromPath,
  toPosixRelative,
  listModuleNames,
  moduleNameFromRelPath,
} from './discovery'
import { ParseCache } from './parse-cache'
import { extractInertiaPageRefs, resolveInertiaPageFile, expectedInertiaPagePath } from './inertia-pages'
import { runArchCheck } from './arch-check'
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
}

/**
 * Module name (e.g. `'billing'`) if `filePath` is under `modules/<name>/`,
 * else `null`. Lets checks that assume a single project-root file (tests,
 * schema) resolve the right module-scoped equivalent instead of always
 * looking at the top level.
 */
function moduleNameFor(cwd: string, filePath: string): string | null {
  return moduleNameFromRelPath(toPosixRelative(cwd, filePath))
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

  if (!options.arch) {
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
      const moduleName = moduleNameFor(cwd, filePath)
      const schemaPath = moduleName ? `modules/${moduleName}/db/schema.ts` : 'db/schema.ts'
      const hasSchema = await fileExists(cwd, schemaPath)
      if (hasSchema) {
        const schemaContent = await readFile(resolve(cwd, schemaPath), 'utf-8')
        const tableLower = name.toLowerCase() + 's'
        const hasTable = schemaContent.includes(`'${tableLower}'`) || schemaContent.includes(`"${tableLower}"`)
        checks.push(
          check(
            `model-schema:${name}`,
            `${name} schema`,
            hasTable ? 'pass' : 'warn',
            hasTable ? `Table definition found for ${name}.` : `No table '${tableLower}' found in ${schemaPath}.`,
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
      const prefix = moduleName ? `modules/${moduleName}/` : ''
      const testCandidates = [
        `${prefix}tests/controllers/${name}.test.ts`,
        `${prefix}tests/${name}.test.ts`,
        `${prefix}app/Http/Controllers/${name}.test.ts`,
      ]
      let hasTest = false
      for (const candidate of testCandidates) {
        if (await fileExists(cwd, candidate)) {
          hasTest = true
          break
        }
      }
      const moduleFlag = moduleName ? ` --module ${moduleName}` : ''
      checks.push(
        check(
          `test:${name}`,
          `${name} tests`,
          hasTest ? 'pass' : 'warn',
          hasTest ? `Test file found for ${name}.` : `No test file found for ${name}.`,
          hasTest ? undefined : `Run: bunx guren make:test ${name.replace('Controller', '')} --controller${moduleFlag}`,
        ),
      )
    }

    // 5. Check generated manifests are present
    const manifests = ['.guren/routes.gen.ts', '.guren/pages.gen.ts', '.guren/data.gen.ts']
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
  }

  // 7. Check architecture boundaries (guren.arch.ts + derived module rules)
  const archResults = await runArchCheck({ cwd, cache, changedFiles })
  checks.push(...archResults)

  const report: CheckReport = {
    cwd,
    checks,
    passCount: checks.filter((c) => c.status === 'pass').length,
    warnCount: checks.filter((c) => c.status === 'warn').length,
    failCount: checks.filter((c) => c.status === 'fail').length,
  }

  return report
}

async function checkEmptyMethods(cache: ParseCache, filePath: string, relPath: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const parsed = await cache.get(filePath)
  if (!parsed) return results
  const { ast } = parsed

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
  // Reuses the cached source read for this file when available (populated by
  // checkEmptyMethods above); falls back to a direct read if the file failed
  // to parse (a syntax error doesn't invalidate this regex-only scan).
  const parsed = await cache.get(filePath)
  const source = parsed?.source ?? (await readFile(filePath, 'utf-8'))

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

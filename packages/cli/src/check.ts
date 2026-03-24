import { resolve, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import { parse } from '@babel/parser'
import { consola } from 'consola'
import {
  discoverControllerFiles,
  discoverModelFiles,
  fileExists,
  classNameFromPath,
} from './discovery'
import { listRoutes } from './route-list'

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface CheckResult {
  key: string
  title: string
  status: CheckStatus
  message: string
  suggestion?: string
  filePath?: string
}

export interface CheckReport {
  cwd: string
  checks: CheckResult[]
  passCount: number
  warnCount: number
  failCount: number
}

export interface RunCheckOptions {
  cwd?: string
  json?: boolean
  routesFile?: string
}

function check(
  key: string,
  title: string,
  status: CheckStatus,
  message: string,
  suggestion?: string,
  filePath?: string,
): CheckResult {
  return { key, title, status, message, suggestion, filePath }
}

export async function runCheck(options: RunCheckOptions = {}): Promise<CheckReport> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const checks: CheckResult[] = []

  // 1. Check controllers for empty methods
  const controllerFiles = await discoverControllerFiles(cwd)
  for (const filePath of controllerFiles) {
    const relPath = relative(cwd, filePath)
    const results = await checkEmptyMethods(filePath, relPath)
    checks.push(...results)
  }

  // 2. Check controllers reference existing pages
  for (const filePath of controllerFiles) {
    const relPath = relative(cwd, filePath)
    const results = await checkInertiaPages(filePath, cwd, relPath)
    checks.push(...results)
  }

  // 3. Check models have migrations
  const modelFiles = await discoverModelFiles(cwd)
  for (const filePath of modelFiles) {
    const relPath = relative(cwd, filePath)
    const name = classNameFromPath(filePath)
    const hasSchema = await fileExists(cwd, 'db/schema.ts')
    if (hasSchema) {
      const schemaContent = await readFile(resolve(cwd, 'db/schema.ts'), 'utf-8')
      const tableLower = name.toLowerCase() + 's'
      const hasTable = schemaContent.includes(`'${tableLower}'`) || schemaContent.includes(`"${tableLower}"`)
      checks.push(
        check(
          `model-schema:${name}`,
          `${name} schema`,
          hasTable ? 'pass' : 'warn',
          hasTable ? `Table definition found for ${name}.` : `No table '${tableLower}' found in db/schema.ts.`,
          hasTable ? undefined : `Add table definition to db/schema.ts for ${name}.`,
          relPath,
        ),
      )
    }
  }

  // 4. Check missing test files for controllers
  for (const filePath of controllerFiles) {
    const name = classNameFromPath(filePath)
    const testCandidates = [
      `tests/controllers/${name}.test.ts`,
      `tests/${name}.test.ts`,
      `app/Http/Controllers/${name}.test.ts`,
    ]
    let hasTest = false
    for (const candidate of testCandidates) {
      if (await fileExists(cwd, candidate)) {
        hasTest = true
        break
      }
    }
    checks.push(
      check(
        `test:${name}`,
        `${name} tests`,
        hasTest ? 'pass' : 'warn',
        hasTest ? `Test file found for ${name}.` : `No test file found for ${name}.`,
        hasTest ? undefined : `Run: bunx guren make:test ${name.replace('Controller', '')} --controller`,
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

  const report: CheckReport = {
    cwd,
    checks,
    passCount: checks.filter((c) => c.status === 'pass').length,
    warnCount: checks.filter((c) => c.status === 'warn').length,
    failCount: checks.filter((c) => c.status === 'fail').length,
  }

  return report
}

async function checkEmptyMethods(filePath: string, relPath: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const source = await readFile(filePath, 'utf-8')

  let ast: ReturnType<typeof parse>
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  } catch {
    return results
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
  filePath: string,
  cwd: string,
  relPath: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const source = await readFile(filePath, 'utf-8')

  // Find this.inertia('PageName', ...) calls via regex (simpler than AST for this)
  const inertiaCallRegex = /this\.inertia\(\s*(?:pages\.[.\w]+|['"]([^'"]+)['"])/g
  let match
  while ((match = inertiaCallRegex.exec(source)) !== null) {
    const pageName = match[1]
    if (!pageName) continue // pages.xxx pattern — already type-checked

    const pagePath = `resources/js/pages/${pageName}.tsx`
    const exists = await fileExists(cwd, pagePath)
    if (!exists) {
      const altPath = `resources/js/pages/${pageName}.jsx`
      const altExists = await fileExists(cwd, altPath)
      if (!altExists) {
        results.push(
          check(
            `page:${pageName}`,
            `Page ${pageName}`,
            'fail',
            `Controller references page '${pageName}' but no file found.`,
            `Create: resources/js/pages/${pageName}.tsx`,
            relPath,
          ),
        )
      }
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

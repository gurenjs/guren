import { resolve, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import { parse } from '@babel/parser'
import { consola } from 'consola'
import {
  collectFiles,
  discoverControllerFiles,
  discoverModelFiles,
  classNameFromPath,
} from './discovery'
import { loadRouteDefinitions } from './load-routes'

export type AuditStatus = 'pass' | 'warn' | 'fail'

export interface AuditFinding {
  key: string
  title: string
  status: AuditStatus
  message: string
  suggestion?: string
  filePath?: string
  line?: number
}

export interface AuditReport {
  cwd: string
  findings: AuditFinding[]
  passCount: number
  warnCount: number
  failCount: number
  routesAnalyzed: boolean
}

export interface RunAuditOptions {
  cwd?: string
  routesFile?: string
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

/**
 * Paths that are expected to be reachable without authentication
 * (guest flows like login/registration).
 */
const GUEST_PATH_PATTERN = /(login|logout|register|signup|sign-up|password|forgot|reset|verification|verify-email)/i

const WEBHOOK_PATH_PATTERN = /(webhook|callback)/i

const AUTH_MIDDLEWARE_PATTERN = /auth/i

/**
 * Calls that actually reject unauthenticated requests. Optional reads like
 * `auth.user()`, `auth.id()`, or `auth.check()` do not enforce anything on
 * their own, so they intentionally do not count as protection.
 */
const AUTH_CALL_PATTERN = /\bauth\s*\.\s*userOrFail\s*(?:<[^>]*>)?\s*\(|\bthis\s*\.\s*apiToken(?:UserId)?\s*(?:<[^>]*>)?\s*\(/
const VALIDATE_BODY_PATTERN = /\bvalidateBody(Safe)?\s*(?:<[^>]*>)?\s*\(/
const BODY_ACCESS_PATTERN = /\b(req|request)\s*\.\s*(json|formData|parseBody|text|body|raw)\b|\bparseRequestPayload\s*\(/

function finding(
  key: string,
  title: string,
  status: AuditStatus,
  message: string,
  suggestion?: string,
  filePath?: string,
  line?: number,
): AuditFinding {
  return { key, title, status, message, suggestion, filePath, line }
}

export async function runAudit(options: RunAuditOptions = {}): Promise<AuditReport> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const findings: AuditFinding[] = []

  const controllerMethods = await parseControllerMethods(cwd)

  const routesAnalyzed = await auditRoutes(cwd, options.routesFile, controllerMethods, findings)
  await auditSourceFiles(cwd, findings)
  await auditModels(cwd, findings)

  return {
    cwd,
    findings,
    passCount: findings.filter((f) => f.status === 'pass').length,
    warnCount: findings.filter((f) => f.status === 'warn').length,
    failCount: findings.filter((f) => f.status === 'fail').length,
    routesAnalyzed,
  }
}

// --- Route-level checks ---

interface ControllerMethodInfo {
  body: string
  filePath: string
}

/**
 * Map of `ClassName.method` → method body source, for every controller in app/Http/Controllers.
 */
async function parseControllerMethods(cwd: string): Promise<Map<string, ControllerMethodInfo>> {
  const methods = new Map<string, ControllerMethodInfo>()
  const controllerFiles = await discoverControllerFiles(cwd)

  for (const filePath of controllerFiles) {
    const source = await readFile(filePath, 'utf-8')
    const relPath = relative(cwd, filePath)

    let ast: ReturnType<typeof parse>
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
      } else if (node.type === 'ClassDeclaration') {
        classDecl = node
      }

      if (!classDecl) continue
      const className = classDecl.id?.name ?? classNameFromPath(filePath)

      for (const member of classDecl.body.body) {
        if (member.type === 'ClassMethod' && member.key.type === 'Identifier') {
          const start = member.body.start ?? 0
          const end = member.body.end ?? 0
          methods.set(`${className}.${member.key.name}`, {
            body: source.slice(start, end),
            filePath: relPath,
          })
        }
      }
    }
  }

  return methods
}

async function auditRoutes(
  cwd: string,
  routesFile: string | undefined,
  controllerMethods: Map<string, ControllerMethodInfo>,
  findings: AuditFinding[],
): Promise<boolean> {
  const resolvedRoutesFile = resolve(cwd, routesFile ?? 'routes/web.ts')

  let definitions
  try {
    definitions = await loadRouteDefinitions(resolvedRoutesFile)
  } catch (error) {
    findings.push(
      finding(
        'routes:load',
        'Route analysis',
        'warn',
        `Could not load routes (${error instanceof Error ? error.message : String(error)}). Route-level checks skipped.`,
        'Ensure routes/web.ts is importable, or pass --routes <file>.',
      ),
    )
    return false
  }

  for (const route of definitions) {
    const method = route.method.toUpperCase()
    if (!MUTATING_METHODS.has(method)) continue

    const routeLabel = `${method} ${route.path}`
    const controllerKey = route.controller
      ? `${route.controller.name}.${route.controller.action}`
      : undefined
    const methodInfo = controllerKey ? controllerMethods.get(controllerKey) : undefined

    // 1. Input validation on body-carrying routes
    if (BODY_METHODS.has(method)) {
      const hasRouteSchema = Boolean(route.schemas?.body)
      // Route-level body schemas are runtime-enforced only for inline handlers.
      // For controller actions the router intentionally leaves body validation
      // to this.validateBody() (the schema is type-information only).
      const routeSchemaEnforced = hasRouteSchema && !route.controller
      const hasControllerValidation = methodInfo ? VALIDATE_BODY_PATTERN.test(methodInfo.body) : false
      const readsBody = methodInfo ? BODY_ACCESS_PATTERN.test(methodInfo.body) : false

      if (routeSchemaEnforced || hasControllerValidation) {
        findings.push(
          finding(
            `validation:${routeLabel}`,
            routeLabel,
            'pass',
            hasControllerValidation
              ? `Controller validates body in ${controllerKey}.`
              : 'Body schema validated at route level.',
          ),
        )
      } else if (methodInfo && !readsBody) {
        findings.push(
          finding(
            `validation:${routeLabel}`,
            routeLabel,
            'pass',
            `${controllerKey} does not consume the request body.`,
          ),
        )
      } else if (methodInfo) {
        findings.push(
          finding(
            `validation:${routeLabel}`,
            routeLabel,
            'fail',
            hasRouteSchema
              ? `Route body schema is type-only for controller actions — ${controllerKey} reads the body without calling validateBody().`
              : `Request body is read without validation in ${controllerKey}.`,
            `Call this.validateBody(schema) in ${controllerKey}.`,
            methodInfo.filePath,
          ),
        )
      } else {
        findings.push(
          finding(
            `validation:${routeLabel}`,
            routeLabel,
            'warn',
            route.controller
              ? `Controller source for ${controllerKey} could not be analyzed — route body schemas are type-only for controller actions.`
              : 'Handler source could not be analyzed and no body schema is attached.',
            route.controller
              ? `Ensure ${controllerKey} calls this.validateBody(schema).`
              : 'Attach a body schema to the route, or validate the payload inside the handler.',
          ),
        )
      }
    }

    // 2. Authentication on mutating routes
    if (GUEST_PATH_PATTERN.test(route.path)) continue

    const middlewareNames = route.middlewareNames ?? []
    const hasAuthMiddleware = middlewareNames.some((name) => AUTH_MIDDLEWARE_PATTERN.test(name))
    const hasControllerAuth = methodInfo ? AUTH_CALL_PATTERN.test(methodInfo.body) : false

    if (hasAuthMiddleware || hasControllerAuth) {
      findings.push(
        finding(
          `authz:${routeLabel}`,
          routeLabel,
          'pass',
          hasAuthMiddleware
            ? `Protected by middleware: ${middlewareNames.join(', ')}.`
            : `Controller checks authentication in ${controllerKey}.`,
        ),
      )
    } else if (route.hasInlineMiddleware) {
      findings.push(
        finding(
          `authz:${routeLabel}`,
          routeLabel,
          'warn',
          'Inline middleware is attached but cannot be inspected — verify it enforces authentication.',
          'Prefer named middleware via router.aliasMiddleware() so audits can verify protection.',
        ),
      )
    } else if (WEBHOOK_PATH_PATTERN.test(route.path)) {
      findings.push(
        finding(
          `authz:${routeLabel}`,
          routeLabel,
          'warn',
          `Webhook-style route has no authentication check${controllerKey ? ` (${controllerKey})` : ''}.`,
          'Webhooks cannot use session auth — verify the provider signature (e.g. HMAC header) before processing the payload.',
          methodInfo?.filePath,
        ),
      )
    } else {
      findings.push(
        finding(
          `authz:${routeLabel}`,
          routeLabel,
          'warn',
          `Mutating route has no authentication check${controllerKey ? ` (${controllerKey})` : ''}.`,
          "Wrap the route in router.middleware('auth').group(...) or call this.auth.userOrFail() in the controller.",
          methodInfo?.filePath,
        ),
      )
    }
  }

  return true
}

// --- File-level checks ---

const SCAN_DIRECTORIES = ['app', 'src', 'routes', 'config']

const SECRET_PATTERN = /\b(secret|password|passwd|api[_-]?key|token|private[_-]?key)\b\s*[:=]\s*['"`]([^'"`]{8,})['"`]/i
const SECRET_ALLOWLIST = /(process\.env|import\.meta\.env|\bz\.|example|placeholder|change[-_ ]?me|your[-_]|dummy|<[^>]*>|\$\{)/i

const RAW_SQL_PATTERN = /\bsql\.raw\s*\(\s*`[^`]*\$\{/
const UNSAFE_SQL_PATTERN = /\.unsafe\s*\(\s*`[^`]*\$\{/

async function auditSourceFiles(cwd: string, findings: AuditFinding[]): Promise<void> {
  const files: string[] = []
  for (const dir of SCAN_DIRECTORIES) {
    files.push(...(await collectFiles(resolve(cwd, dir))))
  }

  let secretCount = 0
  let rawSqlCount = 0
  let toggleCount = 0

  for (const filePath of files) {
    if (filePath.endsWith('.test.ts') || filePath.endsWith('.test.js')) continue

    const relPath = relative(cwd, filePath)
    const source = await readFile(filePath, 'utf-8')
    const lines = source.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const lineNumber = i + 1

      // `// guren-audit-ignore` on the same or preceding line suppresses findings
      if (line.includes('guren-audit-ignore') || lines[i - 1]?.includes('guren-audit-ignore')) {
        continue
      }

      // Hardcoded secrets
      const secretMatch = SECRET_PATTERN.exec(line)
      if (secretMatch && !SECRET_ALLOWLIST.test(line)) {
        secretCount++
        findings.push(
          finding(
            `secret:${relPath}:${lineNumber}`,
            `${relPath}:${lineNumber}`,
            'fail',
            `Possible hardcoded credential ('${secretMatch[1]}').`,
            'Move the value to an environment variable and read it via process.env.',
            relPath,
            lineNumber,
          ),
        )
      }

      // Raw SQL with interpolation
      if (RAW_SQL_PATTERN.test(line) || UNSAFE_SQL_PATTERN.test(line)) {
        rawSqlCount++
        findings.push(
          finding(
            `raw-sql:${relPath}:${lineNumber}`,
            `${relPath}:${lineNumber}`,
            'fail',
            'Raw SQL with string interpolation — potential SQL injection.',
            'Use parameterized queries (drizzle sql`` template binds values safely) instead of sql.raw()/unsafe() with interpolation.',
            relPath,
            lineNumber,
          ),
        )
      }

      // Disabled security defaults
      const toggleMatch = /\b(autoCsrf|securityHeaders|csrf)\s*:\s*false\b/.exec(line)
      if (toggleMatch) {
        toggleCount++
        findings.push(
          finding(
            `security-toggle:${relPath}:${lineNumber}`,
            `${relPath}:${lineNumber}`,
            'warn',
            `Security default '${toggleMatch[1]}' is disabled.`,
            `Re-enable ${toggleMatch[1]} unless you have a compensating control.`,
            relPath,
            lineNumber,
          ),
        )
      }
    }
  }

  if (secretCount === 0) {
    findings.push(finding('secret:none', 'Hardcoded credentials', 'pass', 'No hardcoded credentials detected.'))
  }
  if (rawSqlCount === 0) {
    findings.push(finding('raw-sql:none', 'Raw SQL usage', 'pass', 'No raw SQL with interpolation detected.'))
  }
  if (toggleCount === 0) {
    findings.push(finding('security-toggle:none', 'Security defaults', 'pass', 'No disabled security defaults detected.'))
  }
}

// --- Model checks ---

async function auditModels(cwd: string, findings: AuditFinding[]): Promise<void> {
  const modelFiles = await discoverModelFiles(cwd)

  for (const filePath of modelFiles) {
    const relPath = relative(cwd, filePath)
    const name = classNameFromPath(filePath)
    const source = await readFile(filePath, 'utf-8')

    const hasMassAssignmentConfig = /\bstatic\s+(override\s+)?(fillable|guarded)\b/.test(source)

    findings.push(
      finding(
        `mass-assignment:${name}`,
        `${name} mass assignment`,
        hasMassAssignmentConfig ? 'pass' : 'warn',
        hasMassAssignmentConfig
          ? `${name} declares fillable/guarded.`
          : `${name} declares neither fillable nor guarded — all columns except 'id' are mass-assignable.`,
        hasMassAssignmentConfig
          ? undefined
          : `Add 'static fillable = [...]' to ${relPath} to whitelist assignable columns.`,
        relPath,
      ),
    )
  }
}

// --- Rendering ---

export function renderAuditReport(report: AuditReport): void {
  consola.box(`Guren security audit for ${report.cwd}`)

  if (!report.routesAnalyzed) {
    consola.warn('Route-level checks were skipped (routes could not be loaded).')
  }

  for (const f of report.findings) {
    if (f.status === 'pass') continue
    const log = f.status === 'warn' ? consola.warn : consola.error
    log(`[${f.status}] ${f.title}: ${f.message}`)
    if (f.suggestion) {
      consola.info(`       → ${f.suggestion}`)
    }
  }

  console.log('')
  console.log(
    `Results: ${report.passCount} passed, ${report.warnCount} warnings, ${report.failCount} failures`,
  )

  if (report.failCount === 0 && report.warnCount === 0) {
    consola.success('No security findings.')
  }
}

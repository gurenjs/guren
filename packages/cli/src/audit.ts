import { resolve, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import { consola } from 'consola'
import {
  collectFiles,
  discoverControllerFiles,
  discoverModelFiles,
  classNameFromPath,
  listModuleNames,
} from './discovery'
import { loadRouteDefinitions } from './load-routes'
import type { RouteDefinition } from '@guren/core'
import {
  classifyFindingKey,
  primaryClassificationId,
  type AuditClassification,
} from './audit-taxonomy'
import { dependencyFindingsFromOutput, startDependencyScan, type DependencyScan } from './audit-deps'
import {
  classUsesAuthenticatableBase,
  extractClassDeclaration,
  extractTableIdentifier,
  firstClassDeclaration,
  hasModelConfig,
  resolveModelStringArrayConfig,
} from './model-parser'
import { parseSourceFile } from './parse-cache'
import { parseSchemaTableColumns } from './schema-parser'
import { loadAuditConfig, type AuditIgnoreEntry } from './audit-config'

export type AuditStatus = 'pass' | 'warn' | 'fail' | 'ignored'

export interface AuditFinding {
  key: string
  title: string
  status: AuditStatus
  message: string
  suggestion?: string
  filePath?: string
  line?: number
  /** Set when `status` is 'ignored' — the reason from config/audit.ts. */
  ignoreReason?: string
  /** Standard references (OWASP Top 10 / OWASP API Security / CWE) for the rule. */
  classifications?: AuditClassification[]
}

export interface AuditReport {
  cwd: string
  findings: AuditFinding[]
  passCount: number
  warnCount: number
  failCount: number
  ignoredCount: number
  routesAnalyzed: boolean
  /** Present when the dependency scan ran (or was skipped via options). */
  dependencyScan?: DependencyScan
}

export interface RunAuditOptions {
  cwd?: string
  routesFile?: string
  /** Explicit path to the ignore config (relative to cwd). Defaults to config/audit.{ts,js,mjs}. */
  auditConfigFile?: string
  /**
   * Scan installed dependencies via `bun audit` (requires registry access).
   * Defaults to false here so embedded callers stay hermetic; the `guren
   * audit` command enables it unless invoked with --no-deps.
   */
  deps?: boolean
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

const UNRECOGNIZED_GUARD_SUGGESTION =
  'Use requireAuthenticated() from @guren/core (recognized inline or aliased), or suppress via config/audit.ts if this middleware really enforces authentication.'

export type AuthMiddlewareVerdict =
  /** A middleware in the chain carries the framework's authentication capability. */
  | 'verified'
  /** Old server without capability support; a middleware *name* matched /auth/i. */
  | 'legacy-name-match'
  /** Capabilities are supported, no guard found, but a name looks auth-like. */
  | 'unverified-auth-name'
  /** No authentication middleware detected by any signal. */
  | 'none'

/**
 * Exported for tests. `route` is the shape `Router.definitions()` returns:
 * `capabilities` is always present (possibly empty) on servers with
 * capability support, and absent entirely on older servers. Typed against
 * the server's own RouteDefinition so a capability-shape change over there
 * breaks this compile instead of silently mis-detecting.
 */
export function authMiddlewareVerdict(
  route: Pick<RouteDefinition, 'middlewareNames' | 'capabilities'>,
): AuthMiddlewareVerdict {
  if (route.capabilities?.authentication?.mode === 'required') return 'verified'

  const nameMatches = (route.middlewareNames ?? []).some((name) => AUTH_MIDDLEWARE_PATTERN.test(name))
  if (route.capabilities === undefined) {
    return nameMatches ? 'legacy-name-match' : 'none'
  }
  return nameMatches ? 'unverified-auth-name' : 'none'
}

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

  // Kicked off first so the registry round-trip overlaps the local
  // parsing below; the result is folded in (in stable finding order)
  // once the local scans are done.
  const dependencyScanOutput = options.deps ? startDependencyScan(cwd) : null

  const controllerMethods = await parseControllerMethods(cwd, findings)

  const routesAnalyzed = await auditRoutes(cwd, options.routesFile, controllerMethods, findings)
  auditForceWrites(controllerMethods, findings)
  await auditSourceFiles(cwd, findings)
  await auditModels(cwd, findings)

  const dependencyScan: DependencyScan = dependencyScanOutput
    ? dependencyFindingsFromOutput(await dependencyScanOutput, findings)
    : { status: 'skipped', tool: 'bun audit' }

  for (const entry of findings) {
    entry.classifications ??= classifyFindingKey(entry.key)
  }

  await applyIgnoreConfig(cwd, options.auditConfigFile, findings)

  return {
    cwd,
    findings,
    passCount: findings.filter((f) => f.status === 'pass').length,
    warnCount: findings.filter((f) => f.status === 'warn').length,
    failCount: findings.filter((f) => f.status === 'fail').length,
    ignoredCount: findings.filter((f) => f.status === 'ignored').length,
    routesAnalyzed,
    dependencyScan,
  }
}

// --- Ignore config ---

function configWarning(key: string, message: string, suggestion: string): AuditFinding {
  return finding(key, 'Audit ignore config', 'warn', message, suggestion)
}

/**
 * Applies config/audit.ts ignore entries to warn/fail findings (matched by
 * exact `key`, applied to every finding sharing that key). Ignored findings
 * are kept but flipped to status 'ignored' with `ignoreReason` set, rather
 * than removed — callers see the full picture.
 *
 * Only findings with no source `line` are eligible — those are exactly the
 * route- and model-level findings that have nowhere to attach an inline
 * `// guren-audit-ignore` comment. Findings tied to a specific line (secrets,
 * raw SQL, disabled security toggles) already have that inline mechanism, so
 * config entries targeting them are rejected rather than silently widening
 * what this file can suppress.
 *
 * Entries with a missing/empty reason, entries targeting a line-level
 * finding, and entries that never matched any finding are all reported back
 * as their own findings so ignore rules can't silently rot or overreach.
 */
async function applyIgnoreConfig(
  cwd: string,
  auditConfigFile: string | undefined,
  findings: AuditFinding[],
): Promise<void> {
  const { entries, invalidEntries, loadError } = await loadAuditConfig(cwd, auditConfigFile)

  if (loadError) {
    findings.push(finding('audit-config:load', 'Audit ignore config', 'warn', loadError))
    return
  }

  for (const invalid of invalidEntries) {
    findings.push(
      invalid.issue === 'missing-key'
        ? configWarning(
            'audit-config:invalid',
            `An ignore entry in config/audit.ts is missing a non-empty 'key' and was skipped.`,
            `Set 'key' to the exact finding.key from 'guren audit --json'.`,
          )
        : configWarning(
            'audit-config:invalid',
            `Ignore entry for '${invalid.key}' is missing a non-empty 'reason' and was not applied.`,
            `Add a reason explaining why '${invalid.key}' is safe to ignore.`,
          ),
    )
  }

  const { unused, unsupported } = applyIgnoreEntries(entries, findings)

  for (const entry of unsupported) {
    findings.push(
      configWarning(
        `audit-config:unsupported:${entry.key}`,
        `Ignore entry for '${entry.key}' targets a finding tied to a specific source line and was not applied.`,
        `Use '// guren-audit-ignore' on that line instead of config/audit.ts.`,
      ),
    )
  }

  for (const entry of unused) {
    findings.push(
      configWarning(
        `audit-config:unused:${entry.key}`,
        `Ignore entry for '${entry.key}' did not match any finding — it may be stale.`,
        `Remove the entry for '${entry.key}' from config/audit.ts if it's no longer needed.`,
      ),
    )
  }
}

interface IgnoreApplicationResult {
  /** Entries that matched no finding at all. */
  unused: AuditIgnoreEntry[]
  /** Entries that matched only line-level findings (rejected, not applied). */
  unsupported: AuditIgnoreEntry[]
}

/**
 * Flips every warn/fail finding whose `key` matches an ignore entry to
 * status 'ignored' — all findings sharing a key are affected, not just the
 * first. Findings with a `line` are skipped (see `applyIgnoreConfig`) and
 * their entries are reported as unsupported instead of unused.
 */
function applyIgnoreEntries(
  entries: AuditIgnoreEntry[],
  findings: AuditFinding[],
): IgnoreApplicationResult {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]))
  const matchedSupported = new Set<string>()
  const matchedUnsupported = new Set<string>()

  for (const f of findings) {
    if (f.status !== 'warn' && f.status !== 'fail') continue
    const entry = byKey.get(f.key)
    if (!entry) continue

    if (f.line !== undefined) {
      matchedUnsupported.add(entry.key)
      continue
    }

    matchedSupported.add(entry.key)
    f.status = 'ignored'
    f.ignoreReason = entry.reason
  }

  const unused: AuditIgnoreEntry[] = []
  const unsupported: AuditIgnoreEntry[] = []
  for (const entry of entries) {
    if (matchedUnsupported.has(entry.key)) {
      unsupported.push(entry)
    } else if (!matchedSupported.has(entry.key)) {
      unused.push(entry)
    }
  }

  return { unused, unsupported }
}

// --- Route-level checks ---

interface ControllerMethodInfo {
  body: string
  filePath: string
}

/**
 * Map of `ClassName.method` → method body source, for every controller in
 * app/Http/Controllers (module-aware — see discoverControllerFiles).
 *
 * The map is keyed by class name alone, with no file/module namespacing —
 * routes only carry `route.controller.name` (the class's runtime `.name`),
 * not an import path, so route-level checks below have no way to
 * disambiguate two same-named controllers in different modules. A flat
 * app/Http/Controllers/ directory can't produce this collision (the
 * filesystem itself enforces unique file names), but two modules each
 * scaffolding their own e.g. `PostController` legitimately can. When that
 * happens, findings for BOTH controllers' routes are checked against
 * whichever file was discovered last — a validated action in one module can
 * make an unsafe, same-named one in another module read as "pass". Push a
 * `fail` finding so this isn't silently wrong; renaming one class is the
 * fix (there's no reliable way to disambiguate further without threading
 * source-file identity through Router/RouteDefinition, a larger change).
 */
async function parseControllerMethods(cwd: string, findings: AuditFinding[]): Promise<Map<string, ControllerMethodInfo>> {
  const methods = new Map<string, ControllerMethodInfo>()
  const classFiles = new Map<string, string>()
  const controllerFiles = await discoverControllerFiles(cwd)

  for (const filePath of controllerFiles) {
    const source = await readFile(filePath, 'utf-8')
    const relPath = relative(cwd, filePath)

    const ast = parseSourceFile(source, filePath)
    if (!ast) continue

    for (const node of ast.program.body) {
      const classDecl = extractClassDeclaration(node)
      if (!classDecl) continue
      const className = classDecl.id?.name ?? classNameFromPath(filePath)

      const previousFile = classFiles.get(className)
      if (previousFile && previousFile !== relPath) {
        findings.push(
          finding(
            `controller-name-collision:${className}`,
            `${className} name collision`,
            'fail',
            `${className} is declared in both ${previousFile} and ${relPath} — route-level auth/validation `
            + `checks for both controllers are checked against whichever file was scanned last, since routes `
            + `only carry the class name, not its file. Findings for one may silently apply to the other.`,
            `Rename one of the two ${className} classes so controller class names are unique across the app.`,
          ),
        )
      }
      classFiles.set(className, relPath)

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

/**
 * Heuristic: a controller method that both validates a request body and
 * calls forceCreate/forceUpdate is likely feeding request-derived data past
 * mass-assignment protection — the predictable "fix" for a
 * MassAssignmentException that silently reopens the hole. force* is for
 * trusted server-side values only. Static analysis cannot prove data flow,
 * so this is a review prompt (warn), never a fail.
 */
const FORCE_WRITE_PATTERN = /\bforce(Create|Update)\s*\(/

function auditForceWrites(controllerMethods: Map<string, ControllerMethodInfo>, findings: AuditFinding[]): void {
  for (const [methodKey, info] of controllerMethods) {
    if (!FORCE_WRITE_PATTERN.test(info.body)) continue
    // Same predicate the route-validation check uses, so the two findings
    // cannot disagree about whether a method validates its body — it also
    // covers validateBodySafe and generic validateBody<T>() calls.
    if (!VALIDATE_BODY_PATTERN.test(info.body)) continue

    findings.push(
      finding(
        `force-write-request-data:${methodKey}`,
        `${methodKey} force write`,
        'warn',
        `${methodKey} validates a request body and calls forceCreate/forceUpdate in the same method — `
        + `if the validated input reaches the force* call, mass-assignment protection is bypassed with request data.`,
        `Pass request-derived data through create()/update() (protected), and reserve forceCreate/forceUpdate `
        + `for trusted server-side values assembled without request input.`,
        info.filePath,
      ),
    )
  }
}

async function auditRoutes(
  cwd: string,
  routesFile: string | undefined,
  controllerMethods: Map<string, ControllerMethodInfo>,
  findings: AuditFinding[],
): Promise<boolean> {
  const resolvedRoutesFile = resolve(cwd, routesFile ?? 'routes/web.ts')

  let definitions
  const moduleWarnings: string[] = []
  try {
    definitions = await loadRouteDefinitions(resolvedRoutesFile, cwd, moduleWarnings)
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

  // A module that failed to load isn't a load-routes.ts *failure* — the rest
  // of the app is still analyzed — but its own routes went unchecked, which
  // must be visible in the structured report (not just a console warning)
  // so `guren audit --json`/CI can't mistake it for a clean pass.
  for (const [index, message] of moduleWarnings.entries()) {
    findings.push(
      finding(
        `routes:module-load:${index}`,
        'Route analysis',
        'warn',
        message,
        'Fix the module so its routes can be analyzed, or remove the stale modules/ directory.',
      ),
    )
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
    // Capability verdict (RFC 0007): the server stamps its auth guards
    // (requireAuthenticated/requireGuest) and definitions() aggregates the
    // stamps across aliases, groups, and inline handlers. An older server
    // emits no `capabilities` field at all — only then fall back to the
    // pre-capability name heuristic so mixed-version apps don't regress.
    const verdict = authMiddlewareVerdict(route)
    const hasAuthMiddleware = verdict === 'verified' || verdict === 'legacy-name-match'
    const hasControllerAuth = methodInfo ? AUTH_CALL_PATTERN.test(methodInfo.body) : false

    if (hasAuthMiddleware || hasControllerAuth) {
      findings.push(
        finding(
          `authz:${routeLabel}`,
          routeLabel,
          'pass',
          verdict === 'verified'
            ? 'Protected by an authentication guard (verified via middleware capabilities).'
            : verdict === 'legacy-name-match'
              ? `Protected by middleware: ${middlewareNames.join(', ')}.`
              : `Controller checks authentication in ${controllerKey}.`,
        ),
      )
    } else if (verdict === 'unverified-auth-name') {
      findings.push(
        finding(
          `authz:${routeLabel}`,
          routeLabel,
          'warn',
          `Middleware (${middlewareNames.join(', ')}) is named like an auth guard but is not one the framework recognizes.`,
          UNRECOGNIZED_GUARD_SUGGESTION,
        ),
      )
    } else if (route.hasInlineMiddleware) {
      findings.push(
        finding(
          `authz:${routeLabel}`,
          routeLabel,
          'warn',
          'Inline middleware is attached but is not a recognized authentication guard.',
          UNRECOGNIZED_GUARD_SUGGESTION,
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
  // Each modules/<name>/ directory already contains its own app/, routes.ts,
  // and db/schema.ts, so scanning it as one unit covers all of the above
  // without re-deriving SCAN_DIRECTORIES per module.
  for (const moduleName of await listModuleNames(cwd)) {
    files.push(...(await collectFiles(resolve(cwd, 'modules', moduleName))))
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

/**
 * Column names that look like credentials or secrets. Matching columns
 * must be listed in the model's `static hidden` (or excluded via
 * `static visible`) so serialize()/toJSON() never exposes them.
 */
const SENSITIVE_COLUMN_PATTERN = /(password|passwd|secret|token|salt|hash)/i

interface ModelSerializationInfo {
  tableIdentifier?: string
  hidden?: string[]
  visible?: string[]
}

/**
 * Extract the model's table plus `static hidden`/`static visible` from a model
 * source via AST (regexes would count string literals inside comments). The
 * table is resolved through `extractTableIdentifier`, so models that bind it
 * via `defineModel(users, …)` are covered as well as `static table = users`.
 */
function parseModelSerializationInfo(source: string, filePath: string): ModelSerializationInfo {
  const info: ModelSerializationInfo = {}

  // errorRecovery: `override` members parse-error without an extends clause,
  // and a half-AST is better than nothing for this scan.
  const ast = parseSourceFile(source, filePath, { errorRecovery: true })
  if (!ast) return info

  for (const node of ast.program.body) {
    const classDecl = extractClassDeclaration(node)
    if (!classDecl) continue

    info.tableIdentifier = extractTableIdentifier(classDecl) ?? info.tableIdentifier

    // Static declaration or defineModel option — resolved with the runtime's
    // shadowing order (static wins).
    info.hidden = resolveModelStringArrayConfig(classDecl, 'hidden') ?? info.hidden
    info.visible = resolveModelStringArrayConfig(classDecl, 'visible') ?? info.visible
  }

  return info
}

async function auditModels(cwd: string, findings: AuditFinding[]): Promise<void> {
  const modelFiles = await discoverModelFiles(cwd)
  const schemaTables = modelFiles.length > 0 ? await parseSchemaTableColumns(cwd) : null

  for (const filePath of modelFiles) {
    const relPath = relative(cwd, filePath)
    const name = classNameFromPath(filePath)
    const source = await readFile(filePath, 'utf-8')

    // AST classification, not source-text matching — a comment mentioning
    // AuthenticatableModel must not flip this model to structurally
    // protected, and a modifier-prefixed fillable must still count.
    const ast = parseSourceFile(source, filePath)
    const classDecl = ast ? firstClassDeclaration(ast.program.body) : null
    const hasFillable = classDecl ? hasModelConfig(classDecl, 'fillable') : false
    const isAuthenticatable = classDecl ? classUsesAuthenticatableBase(classDecl) : false

    // Authenticatable models are structurally protected: their credential
    // columns are denied from mass assignment by the framework, so a missing
    // fillable is not the exposure it is on a plain model. Warning here
    // would be a false positive; note the structural cover instead.
    findings.push(
      finding(
        `mass-assignment:${name}`,
        `${name} mass assignment`,
        hasFillable || isAuthenticatable ? 'pass' : 'warn',
        hasFillable
          ? `${name} declares fillable.`
          : isAuthenticatable
            ? `${name} extends AuthenticatableModel — credential columns are denied structurally; add fillable to also allowlist the rest.`
            : `${name} declares no fillable — all columns except 'id' are mass-assignable.`,
        hasFillable || isAuthenticatable
          ? undefined
          : `Add a fillable allowlist to ${relPath} — the typed 'defineModel(table, { fillable: [...] })' option or 'static fillable = [...]'.`,
        relPath,
      ),
    )

    // Sensitive columns must be excluded from serialization via hidden/visible.
    const info = parseModelSerializationInfo(source, filePath)
    const columns = info.tableIdentifier ? schemaTables?.get(info.tableIdentifier) : undefined
    if (!columns) continue

    const sensitiveColumns = columns.filter((column) => SENSITIVE_COLUMN_PATTERN.test(column))
    if (sensitiveColumns.length === 0) continue

    // Mirror serializeRecord: a non-empty visible allowlist wins and hidden is
    // ignored entirely; an empty visible array is ignored at runtime.
    const visibleActive = info.visible !== undefined && info.visible.length > 0
    const hidden = new Set(info.hidden ?? [])
    const exposed = sensitiveColumns.filter((column) =>
      visibleActive ? info.visible!.includes(column) : !hidden.has(column),
    )

    findings.push(
      finding(
        `hidden-columns:${name}`,
        `${name} hidden columns`,
        exposed.length === 0 ? 'pass' : 'warn',
        exposed.length === 0
          ? `${name} hides its sensitive column(s): ${sensitiveColumns.join(', ')}.`
          : `${name} serializes sensitive-looking column(s) ${exposed.join(', ')} — serialize()/toJSON() and Inertia props will expose them.`,
        exposed.length === 0
          ? undefined
          : visibleActive
            ? `Remove ${exposed.map((c) => `'${c}'`).join(', ')} from the visible allowlist in ${relPath} (a non-empty visible allowlist overrides hidden).`
            : `Add ${exposed.map((c) => `'${c}'`).join(', ')} to the hidden list in ${relPath} — the typed 'defineModel(table, { hidden: [...] })' option or 'static hidden = [...]'.`,
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
  if (report.dependencyScan?.status === 'skipped') {
    consola.info('Dependency scan skipped (--no-deps).')
  }

  for (const f of report.findings) {
    if (f.status === 'pass') continue
    if (f.status === 'ignored') {
      consola.info(`[ignored] ${f.title}: ${f.message} (${f.ignoreReason})`)
      continue
    }
    const log = f.status === 'warn' ? consola.warn : consola.error
    const classification = primaryClassificationId(f.classifications)
    log(`[${f.status}]${classification ? ` [${classification}]` : ''} ${f.title}: ${f.message}`)
    if (f.suggestion) {
      consola.info(`       → ${f.suggestion}`)
    }
  }

  console.log('')
  console.log(
    `Results: ${report.passCount} passed, ${report.warnCount} warnings, ${report.failCount} failures, ${report.ignoredCount} ignored`,
  )

  if (report.failCount === 0 && report.warnCount === 0) {
    consola.success(
      report.ignoredCount > 0
        ? `No unresolved security findings (${report.ignoredCount} ignored via config/audit.ts).`
        : 'No security findings.',
    )
  }
}

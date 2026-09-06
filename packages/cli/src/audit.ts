import { resolve, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import { consola } from 'consola'
import {
  collectFiles,
  discoverModelFiles,
  classNameFromPath,
  listModuleNames,
} from './discovery'
import { loadRouteDefinitions } from './load-routes'
import { routesEntryOrDefault } from './route-registrar'
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
// Every pattern naming a `Controller` member lives beside the scan that
// produces the bodies, inside the reach of controller-surface.test.ts.
import {
  accessorCallPattern,
  controllerMembers,
  mutatesRecords,
  parseControllerMethods,
  AUTH_CALL_PATTERN,
  FORCE_WRITE_PATTERN,
  type ControllerMethodInfo,
  type ControllerNameCollision,
} from './controller-methods'
import { describeMethod } from './http-methods'
import { parseSchemaTableColumns } from './schema-parser'
import { loadAuditConfig, type AuditIgnoreEntry } from './audit-config'
import { auditCsrfExemptions, DECLARE_CALL_PATTERN, type CsrfExemptionScan } from './csrf-exemption-audit'

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
  /** Coverage of the installed-package scan for CSRF exemptions. */
  csrfExemptionScan: CsrfExemptionScan
}

export interface RunAuditOptions {
  cwd?: string
  routesFile?: string
  /** Explicit path to the ignore config (relative to cwd). Defaults to config/audit.{ts,js,mjs}. */
  auditConfigFile?: string
  /**
   * Scan installed dependencies via `bun audit` (requires registry access).
   * False by default so embedded callers stay hermetic; the `guren audit`
   * command enables it unless invoked with --no-deps.
   */
  deps?: boolean
}

/** Guest flows (login/registration), reachable without authentication. */
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
 * `capabilities` is present (possibly empty) on servers with capability support
 * and absent entirely on older ones. Typed against the server's own
 * RouteDefinition so a capability-shape change there breaks this compile rather
 * than silently mis-detecting.
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

const VALIDATE_BODY_PATTERN = new RegExp(accessorCallPattern(controllerMembers('body-validation')))

/** Reading the body without going through the controller's helpers at all. */
const RAW_BODY_READ_PATTERN = /\b(req|request)\s*\.\s*(json|formData|parseBody|text|body|raw|arrayBuffer|blob)\b|\bparseRequestPayload\s*\(/

/**
 * `this.` is required on the controller-accessor half: the members are
 * `protected`, so a call through anything else is a different API.
 */
const BODY_ACCESS_PATTERN = new RegExp(
  `${RAW_BODY_READ_PATTERN.source}|\\bthis\\s*\\.\\s*${accessorCallPattern(controllerMembers('body-payload'))}`,
)

/**
 * The `body-payload` members that read upload bytes rather than fields. Named
 * once because the two patterns below partition `body-payload` by it: a member
 * spelled into only one would be a body read that counts as neither.
 */
const FILE_UPLOAD_MEMBERS: readonly string[] = ['file', 'files']

/**
 * The body reads that are *only* file uploads. Subtracting them from
 * BODY_ACCESS_PATTERN is what lets the attach() rule below recognize an
 * action whose whole body consumption is upload bytes.
 */
const FILE_READ_PATTERN = new RegExp(`\\bthis\\s*\\.\\s*${accessorCallPattern(FILE_UPLOAD_MEMBERS)}`)

/** Every body read that is not a file upload (nor validation/incidental). */
const NON_FILE_BODY_ACCESS_PATTERN = new RegExp(
  `${RAW_BODY_READ_PATTERN.source}|\\bthis\\s*\\.\\s*${accessorCallPattern(
    controllerMembers('body-payload').filter((name) => !FILE_UPLOAD_MEMBERS.includes(name)),
  )}`,
)

/**
 * A typed attachment write: `Post.attach(...)` (RFC 0013). PascalCase receiver
 * required, so a stray `emitter.attach(handler)` does not count as upload
 * validation. The attach pipeline validates per the model's declaration, which
 * is why an action reading only file()/files() into it needs no validateBody().
 */
const MODEL_ATTACH_PATTERN = /\b[A-Z][A-Za-z0-9_]*\s*\.\s*attach\s*(?:<[^()]*>)?\s*\(/

/**
 * A raw storage write in the same method disqualifies the attach-aware pass:
 * this rule proves co-occurrence, not data flow, so an action that reads an
 * upload, attach()es something and *also* put()s bytes may be storing the
 * unvalidated upload through the raw path.
 */
const STORAGE_WRITE_PATTERN = /\.\s*put(?:File)?\s*\(/

const BODY_INCIDENTAL_PATTERN = new RegExp(
  `\\bthis\\s*\\.\\s*${accessorCallPattern(controllerMembers('body-incidental'))}`,
)

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

  // Kicked off first so the registry round-trip overlaps the local parsing.
  const dependencyScanOutput = options.deps ? startDependencyScan(cwd) : null

  const { methods: controllerMethods, collisions, unreadableFiles } = await parseControllerMethods(cwd)
  for (const collision of collisions) {
    findings.push(controllerCollisionFinding(collision))
  }
  // A controller that would not open is judged against no body at all, which
  // is a pass for every rule below. Reported so it cannot read as one.
  for (const filePath of unreadableFiles) {
    findings.push(
      finding(
        `controller-unreadable:${filePath}`,
        `${filePath} unreadable`,
        'warn',
        `${filePath} could not be read, so the validation, authentication, and annotation rules saw no `
        + 'body for any action it declares.',
        `Check the file's permissions and that it still exists, then re-run: bunx guren audit`,
        filePath,
      ),
    )
  }

  const routesAnalyzed = await auditRoutes(cwd, options.routesFile, controllerMethods, findings)
  auditForceWrites(controllerMethods, findings)
  await auditSourceFiles(cwd, findings)
  await auditModels(cwd, findings)
  const csrfExemptionScan = await auditCsrfExemptions(cwd, findings)

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
    csrfExemptionScan,
  }
}

function configWarning(key: string, message: string, suggestion: string): AuditFinding {
  return finding(key, 'Audit ignore config', 'warn', message, suggestion)
}

/**
 * Applies config/audit.ts ignore entries to warn/fail findings, matched by exact
 * `key` and flipped to status 'ignored' rather than removed.
 *
 * Only findings with no source `line` are eligible: a line-level finding already
 * has the inline `// guren-audit-ignore` mechanism, so config entries targeting
 * one are rejected. Invalid, unsupported and unmatched entries are each reported
 * as their own finding, so ignore rules cannot silently rot or overreach.
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
 * Flips every warn/fail finding whose `key` matches an ignore entry to status
 * 'ignored'. Findings with a `line` are skipped (see `applyIgnoreConfig`) and
 * their entries reported as unsupported instead of unused.
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

/**
 * A same-named controller class in two files: every route-level verdict below is
 * drawn from whichever file was scanned last and may describe the other class.
 */
function controllerCollisionFinding(collision: ControllerNameCollision): AuditFinding {
  const { className, previousFile, currentFile } = collision
  return finding(
    `controller-name-collision:${className}`,
    `${className} name collision`,
    'fail',
    `${className} is declared in both ${previousFile} and ${currentFile} — route-level auth/validation `
    + `checks for both controllers are checked against whichever file was scanned last, since routes `
    + `only carry the class name, not its file. Findings for one may silently apply to the other.`,
    `Rename one of the two ${className} classes so controller class names are unique across the app.`,
  )
}

/**
 * A controller method that both validates a request body and calls
 * forceCreate/forceUpdate is likely feeding request-derived data past
 * mass-assignment protection. Static analysis cannot prove data flow, so this is
 * a review prompt (warn), never a fail.
 */
function auditForceWrites(controllerMethods: Map<string, ControllerMethodInfo>, findings: AuditFinding[]): void {
  for (const [methodKey, info] of controllerMethods) {
    if (!FORCE_WRITE_PATTERN.test(info.body)) continue
    // Same predicate the route-validation check uses, so the two findings
    // cannot disagree about whether a method validates its body.
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
  const resolvedRoutesFile = resolve(cwd, await routesEntryOrDefault(cwd, routesFile))

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
        'Ensure the routes entry (routes/web.ts or routes/api.ts) is importable, or pass --routes <file>.',
      ),
    )
    return false
  }

  // A module that failed to load leaves its own routes unchecked, which must
  // reach the structured report so `guren audit --json`/CI cannot read a pass.
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
    const { safe, bodyCarrying } = describeMethod(method)
    // No shared skip here on purpose: each phase gates on its own predicate, so
    // a later one cannot silently inherit a scope from a mid-loop `continue`.

    const routeLabel = `${method} ${route.path}`
    const controllerKey = route.controller
      ? `${route.controller.name}.${route.controller.action}`
      : undefined
    const methodInfo = controllerKey ? controllerMethods.get(controllerKey) : undefined
    /** RFC 0016: the route is declared as an agent tool, which tightens rules below. */
    const agentExposed = Boolean(route.agent)

    // 1. Input validation on body-carrying routes
    if (bodyCarrying) {
      const hasRouteSchema = Boolean(route.schemas?.body)
      // Route-level body schemas are runtime-enforced only for inline handlers;
      // for controller actions the schema is type-information only.
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
      } else if (
        methodInfo &&
        readsBody &&
        !NON_FILE_BODY_ACCESS_PATTERN.test(methodInfo.body) &&
        FILE_READ_PATTERN.test(methodInfo.body) &&
        MODEL_ATTACH_PATTERN.test(methodInfo.body) &&
        !STORAGE_WRITE_PATTERN.test(methodInfo.body)
      ) {
        // With no other body reads, the attach pipeline is the whole validation.
        findings.push(
          finding(
            `validation:${routeLabel}`,
            routeLabel,
            'pass',
            `${controllerKey} reads only file uploads and hands them to a typed attach(), whose declaration-driven pipeline validates them.`,
          ),
        )
      } else if (methodInfo && !readsBody) {
        // A body-incidental read is still a read, so claiming the action never
        // touches the body would be false — say what it actually took instead.
        const incidental = BODY_INCIDENTAL_PATTERN.test(methodInfo.body)
        findings.push(
          finding(
            `validation:${routeLabel}`,
            routeLabel,
            'pass',
            incidental
              ? `${controllerKey} only tests the request body for a key, so no unvalidated value reaches the app.`
              : `${controllerKey} does not consume the request body.`,
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
        // An unanalyzable handler is a warn for an ordinary route and a fail for
        // an agent-exposed one (RFC 0016 §13). Escalated in place rather than
        // under a new key, so an existing config/audit.ts entry keeps applying.
        findings.push(
          finding(
            `validation:${routeLabel}`,
            routeLabel,
            agentExposed ? 'fail' : 'warn',
            (route.controller
              ? `Controller source for ${controllerKey} could not be analyzed — route body schemas are type-only for controller actions.`
              : 'Handler source could not be analyzed and no body schema is attached.')
            + (agentExposed
              ? ' The route is exposed as an agent tool, so nothing between the agent and the handler validates the payload.'
              : ''),
            route.controller
              ? `Ensure ${controllerKey} calls this.validateBody(schema).`
              : 'Attach a body schema to the route, or validate the payload inside the handler.',
          ),
        )
      }
    }

    // 2. Authentication on unsafe (state-changing) routes. Safe body-carrying
    // methods (QUERY) are read routes; guest flows must stay unauthenticated.
    if (!safe && !GUEST_PATH_PATTERN.test(route.path)) {
      const middlewareNames = route.middlewareNames ?? []
      // Capability verdict (RFC 0007). An older server emits no `capabilities`
      // field at all — only then does the name heuristic apply, so mixed-version
      // apps don't regress.
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

    // 3. Annotation honesty (RFC 0016 §5.5). `destructiveHint: false` claims
    // "additive updates only", which clients read as safe to call unattended.
    // Only an explicit `false` is judged: the MCP spec's default for a
    // non-read-only tool is already `true`, so an absent hint claims nothing.
    if (route.agent?.destructiveHint === false) {
      // For an agent-exposed route an unknown is a finding, not silence.
      if (!methodInfo) {
        findings.push(
          finding(
            `agent-annotation:${routeLabel}`,
            routeLabel,
            'warn',
            `The route declares destructiveHint: false, and the handler body that claim would be checked `
            + `against could not be analyzed${controllerKey ? ` (${controllerKey})` : ''}.`,
            'Ensure the action is among the controller sources the audit reads, or drop destructiveHint: false '
            + '— the spec default for a non-read-only tool is destructive.',
          ),
        )
      } else if (mutatesRecords(methodInfo.body)) {
        findings.push(
          finding(
            `agent-annotation:${routeLabel}`,
            routeLabel,
            'warn',
            `The route declares destructiveHint: false, but ${controllerKey} deletes, updates, or force-writes `
            + 'records. Clients read that hint as "additive updates only" and may run the tool without asking '
            + 'the user first.',
            `Drop destructiveHint: false from the route's agent metadata (the spec default for a non-read-only `
            + `tool is destructive), or move the state change out of ${controllerKey}.`,
            methodInfo.filePath,
          ),
        )
      }
    }
  }

  return true
}

const SCAN_DIRECTORIES = ['app', 'src', 'routes', 'config']

const SECRET_PATTERN = /\b(secret|password|passwd|api[_-]?key|token|private[_-]?key)\b\s*[:=]\s*['"`]([^'"`]{8,})['"`]/i
const SECRET_ALLOWLIST = /(process\.env|import\.meta\.env|\bz\.|example|placeholder|change[-_ ]?me|your[-_]|dummy|<[^>]*>|\$\{)/i

const RAW_SQL_PATTERN = /\bsql\.raw\s*\(\s*`[^`]*\$\{/
const UNSAFE_SQL_PATTERN = /\.unsafe\s*\(\s*`[^`]*\$\{/

/**
 * Absolute links that leave the app (password reset, email verification) must not
 * be derived from the request: the URL is rebuilt from the forgeable `Host` header,
 * so an attacker can have the app mail a victim a genuine token pointing at their
 * server. No `.origin`/`.host` read is required (`const url = new URL(req.url)` is
 * read a line later), and the `[^)]` runs are bounded: 15,111ms unbounded vs 0.02ms.
 */
const REQUEST_ORIGIN_PATTERN =
  /new\s+URL\s*\([^)]{0,200}\b(?:req|request)\s*\.\s*url\b[^)]{0,200}\)(?!\s*\.\s*(?:pathname|searchParams|search|hash)\b)/

/** `.header('host')`, `.get('host')`, `.headers.host` — and the forwarded/HTTP2 spellings. */
const HOST_HEADER_READ_PATTERN =
  /\.\s*(?:header|get)\s*\(\s*['"`](?:host|x-forwarded-host|:authority)['"`]\s*\)|\.\s*headers\s*\??\s*\.\s*host\b/i

/** Pairs with the above so `response.headers.get('host')` stays clean. */
const REQUEST_RECEIVER_PATTERN = /\b(?:req|request)\b/i

/**
 * The framework's own outbound-link builders: their presence in a file promotes a
 * request-derived origin from "reads its own host" to "mails it to someone else".
 * Matched by bare name so an aliased import still counts. `buildOAuthAuthorizeUrl`
 * is deliberately absent: a request-derived `redirect_uri` is a different risk. An
 * audit test enumerates `@guren/core`'s `build*Url` exports against this list.
 */
const LINK_BUILDER_NAMES = 'TokenUrl|PasswordResetUrl|VerificationUrl|OAuthRedirectUrl'

export const LINK_BUILDER_PATTERN = new RegExp(`\\bbuild(?:${LINK_BUILDER_NAMES})\\b`)

/**
 * A builder handed the request URL directly. Its own anchor rather than a
 * two-test conjunction because `[^)]*` cannot cross the inner `)`, which is what
 * keeps the sanctioned `buildVerificationUrl(appUrl(this.request) + '/x', …)`
 * from matching. Built from the same name list as the pattern above.
 */
const LINK_BUILDER_FROM_REQUEST_PATTERN = new RegExp(
  `\\bbuild(?:${LINK_BUILDER_NAMES})\\s*\\([^)]{0,200}\\b(?:req|request)\\s*\\.\\s*url\\b`,
)

async function auditSourceFiles(cwd: string, findings: AuditFinding[]): Promise<void> {
  const files: string[] = []
  for (const dir of SCAN_DIRECTORIES) {
    files.push(...(await collectFiles(resolve(cwd, dir))))
  }
  // Each modules/<name>/ holds its own app/, routes.ts and db/schema.ts, so
  // scanning it as one unit covers SCAN_DIRECTORIES without re-deriving them.
  for (const moduleName of await listModuleNames(cwd)) {
    files.push(...(await collectFiles(resolve(cwd, 'modules', moduleName))))
  }

  let secretCount = 0
  let rawSqlCount = 0
  let toggleCount = 0
  let requestHostUrlCount = 0
  let appExemptionCount = 0

  for (const filePath of files) {
    if (filePath.endsWith('.test.ts') || filePath.endsWith('.test.js')) continue

    const relPath = relative(cwd, filePath)
    const source = await readFile(filePath, 'utf-8')
    const lines = source.split('\n')

    // File-level gate for the request-host rule below: the origin only
    // becomes a finding once the same file also builds a link out of it.
    const buildsOutboundLink = LINK_BUILDER_PATTERN.test(source)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const lineNumber = i + 1

      // `// guren-audit-ignore` on the same or preceding line suppresses findings
      if (line.includes('guren-audit-ignore') || lines[i - 1]?.includes('guren-audit-ignore')) {
        continue
      }

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

      // `hostAuthorization` is here because the templates themselves shipped
      // `hostAuthorization: ... ? false : {...}`, off in production and clean.
      const toggleMatch = /\b(autoCsrf|securityHeaders|csrf|hostAuthorization)\s*:\s*false\b/.exec(line)
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

      // A receiver split across lines is missed, like every other rule here.
      if (DECLARE_CALL_PATTERN.test(line)) {
        appExemptionCount++
        findings.push(
          finding(
            `csrf-exemption:app:${relPath}:${lineNumber}`,
            `${relPath}:${lineNumber}`,
            'warn',
            'Application source exempts a path from CSRF verification via declareCookielessAuthPath().',
            'Use csrfOptions.exclude, which is the app-facing lever and reads as a decision the app made. '
            + 'Keep this call only if the endpoint resolves its principal without ever reading a session '
            + 'cookie — otherwise the path is served with CSRF disarmed.',
            relPath,
            lineNumber,
          ),
        )
      }

      // Phrased conditionally, like the force-write rule: co-occurrence in one
      // file is not proof the host reaches the link.
      if (
        buildsOutboundLink &&
        (REQUEST_ORIGIN_PATTERN.test(line) ||
          (REQUEST_RECEIVER_PATTERN.test(line) && HOST_HEADER_READ_PATTERN.test(line)) ||
          LINK_BUILDER_FROM_REQUEST_PATTERN.test(line))
      ) {
        requestHostUrlCount++
        findings.push(
          finding(
            `request-host-url:${relPath}:${lineNumber}`,
            `${relPath}:${lineNumber}`,
            'warn',
            "Request-derived host in a file that builds outbound links — if it reaches the link, a forged "
            + "Host header points a genuine single-use token at the attacker's server.",
            'Build the base URL from process.env.APP_URL and fail closed when it is unset — a request-host '
            + 'fallback is still forgeable. `guren add auth` scaffolds app/Auth/AppUrl.ts for this.',
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
  if (requestHostUrlCount === 0) {
    findings.push(finding('request-host-url:none', 'Request-derived link URLs', 'pass', 'No outbound links built from the request host.'))
  }
  if (appExemptionCount === 0) {
    findings.push(finding('csrf-exemption:app', 'Application CSRF exemptions', 'pass', 'No application source exempts a path from CSRF verification.'))
  }
}

/**
 * Column names that look like credentials. A match must be listed in the model's
 * `hidden` (or excluded via `visible`) so serialize()/toJSON() never emits it.
 */
const SENSITIVE_COLUMN_PATTERN = /(password|passwd|secret|token|salt|hash)/i

interface ModelSerializationInfo {
  tableIdentifier?: string
  hidden?: string[]
  visible?: string[]
}

/**
 * The model's table plus `hidden`/`visible`, read via AST because a regex would
 * count string literals inside comments. Covers `defineModel(users, …)` as well
 * as `static table = users`.
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

    // AST classification, not source text: a comment mentioning
    // AuthenticatableModel must not flip this model to structurally protected.
    const ast = parseSourceFile(source, filePath)
    const classDecl = ast ? firstClassDeclaration(ast.program.body) : null
    const hasFillable = classDecl ? hasModelConfig(classDecl, 'fillable') : false
    const isAuthenticatable = classDecl ? classUsesAuthenticatableBase(classDecl) : false

    // Authenticatable models deny their credential columns from mass assignment
    // structurally, so a missing fillable is not the exposure it is elsewhere.
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

export function renderAuditReport(report: AuditReport): void {
  consola.box(`Guren security audit for ${report.cwd}`)

  if (!report.routesAnalyzed) {
    consola.warn('Route-level checks were skipped (routes could not be loaded).')
  }
  if (report.dependencyScan?.status === 'skipped') {
    consola.info('Dependency scan skipped (--no-deps).')
  }
  // Only the first-party case needs this: the finding list hides passes, and a
  // third-party declarer is already named by its own warn two lines down.
  const quietDeclarers = report.findings.some((f) => f.key === 'csrf-exemption:plugin' && f.status === 'pass')
    ? report.csrfExemptionScan.declaredBy
    : []
  if (quietDeclarers.length > 0) {
    consola.info(
      `CSRF exemption declared by: ${quietDeclarers.join(', ')} `
      + '(path chosen at boot from each package\'s configuration).',
    )
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

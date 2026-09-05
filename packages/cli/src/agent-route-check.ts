import { relative, resolve } from 'node:path'
import type { CallExpression } from '@babel/types'
import {
  AGENT_APPROVAL_CONFIG_KEY,
  isReservedAgentToolName,
  RESERVED_AGENT_TOOL_NAMES,
} from '@guren/core'
import type { AgentRouteMetadata, RouteDefinition } from '@guren/core'
import { memberKeyName, objectLiteral, walk } from './ast-walk'
import { check, type CheckResult } from './check-result'
import {
  mutatesRecords,
  parseControllerMethods,
  AUTHORIZE_CALL_PATTERN,
  AUTH_CALL_PATTERN,
  EMPTY_CONTROLLER_SCAN,
  INERTIA_CALL_PATTERN,
  type ControllerMethodInfo,
} from './controller-methods'
import { collectFiles, fileExists, listAppRoots } from './discovery'
import { describeMethod } from './http-methods'
import { DEFAULT_ROUTES_FILE, loadRouteDefinitions } from './load-routes'
import { ParseCache, type ParsedFile } from './parse-cache'

export interface AgentRouteCheckOptions {
  cwd: string
  /** Routes entry file, POSIX-relative to `cwd`. Defaults to `routes/web.ts`. */
  routesFile?: string
  /** Definitions to check instead of loading them, so one `guren check` run loads the graph once. */
  definitions?: RouteDefinition[]
  /** Parse cache to read controller sources through, shared so files are not parsed twice. */
  cache?: ParseCache
}

/**
 * The MCP tool-name grammar (SEP-986, RFC 0016 §1). `deriveAgentTools` knows it
 * too; RFC 0016 §1 is the shared source until one side can import the other, so
 * do not fork the pattern.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/**
 * Methods whose tools default to `readOnlyHint: true` (RFC 0016 §1). Narrower
 * than `describeMethod().safe` on purpose: HEAD/OPTIONS would gain the
 * authorization-rule exemption below on a default nobody wrote.
 */
const AGENT_READ_ONLY_METHODS = new Set(['GET', 'QUERY'])

interface AgentRoute {
  definition: RouteDefinition
  agent: AgentRouteMetadata
  method: string
  /** The tool's identity: `toolName ?? name`. Undefined when the route has no name. */
  toolName?: string
  label: string
  /** Stable finding-key suffix, unique per route even when the tool name is not. */
  keySuffix: string
  controllerKey?: string
  methodInfo?: ControllerMethodInfo
}

function readOnlyOf(route: AgentRoute): boolean {
  return route.agent.readOnlyHint ?? AGENT_READ_ONLY_METHODS.has(route.method)
}

/** `readOnlyHint: true` written rather than inherited — what exempts a mutating route below. */
function overridesReadOnly(route: AgentRoute): boolean {
  return route.agent.readOnlyHint === true && !AGENT_READ_ONLY_METHODS.has(route.method)
}

function describesOutput(definition: RouteDefinition): boolean {
  return Boolean(definition.schemas?.output || definition.resource)
}

function nameFinding(route: AgentRoute): CheckResult | undefined {
  if (route.toolName !== undefined) return undefined

  return check(
    `agent-route-name:${route.keySuffix}`,
    `${route.label} agent tool`,
    'fail',
    'The route declares agent metadata but has no route name. The tool name is the tool\'s identity — '
    + 'an agent addresses it by name, and the ability vocabulary is keyed on it — so a nameless route '
    + 'cannot become a tool at all.',
    'Chain .name(\'posts.store\') on the route (or pass `name` in its options), or drop the agent metadata.',
  )
}

function toolNameFinding(route: AgentRoute): CheckResult | undefined {
  const { toolName } = route
  if (toolName === undefined || TOOL_NAME_PATTERN.test(toolName)) return undefined

  const source = route.agent.toolName !== undefined ? 'agent toolName override' : 'route name'
  return check(
    `agent-route-tool-name:${route.keySuffix}`,
    `${route.label} agent tool`,
    'fail',
    `The tool name '${toolName}' (from the ${source}) is not a legal MCP tool name: the grammar is `
    + '^[A-Za-z0-9._-]{1,128}$. A client rejects the whole tool list rather than the one tool.',
    'Rename the route, or set agent.toolName to a name matching that grammar (dots are allowed, so '
    + '\'posts.store\' needs no transformation).',
  )
}

/**
 * A tool name the framework occupies (RFC 0016 §5.4). The reserved list is
 * imported, never restated: drift from `@guren/plugin-mcp`'s catalogue would
 * pass a route whose tool the endpoint has already dropped.
 */
function reservedNameFinding(route: AgentRoute): CheckResult | undefined {
  const { toolName } = route
  if (toolName === undefined || !isReservedAgentToolName(toolName)) return undefined

  const source = route.agent.toolName !== undefined ? 'agent toolName override' : 'route name'
  return check(
    `agent-route-reserved-name:${route.keySuffix}`,
    `${route.label} agent tool`,
    'fail',
    `The tool name '${toolName}' (from the ${source}) is reserved by the framework: agent surfaces `
    + 'add it to the catalogue themselves as a meta-tool. A route claiming it is not exposed at all. '
    + `Reserved names: ${RESERVED_AGENT_TOOL_NAMES.join(', ')}.`,
    'Rename the route, or set agent.toolName to a name outside the reserved list.',
  )
}

/**
 * One finding per collision group rather than per route. A name the grammar
 * rejects is skipped: it already fails under its own rule and renaming fixes both.
 */
function duplicateFindings(routes: AgentRoute[]): CheckResult[] {
  const byToolName = new Map<string, AgentRoute[]>()
  for (const route of routes) {
    if (route.toolName === undefined || !TOOL_NAME_PATTERN.test(route.toolName)) continue
    const group = byToolName.get(route.toolName)
    if (group) group.push(route)
    else byToolName.set(route.toolName, [route])
  }

  const results: CheckResult[] = []
  for (const [toolName, group] of byToolName) {
    if (group.length < 2) continue
    results.push(
      check(
        `agent-route-duplicate:${toolName}`,
        `${toolName} agent tool`,
        'fail',
        `${group.length} routes resolve to the tool name '${toolName}': `
        + `${group.map((route) => route.label).join(', ')}. The tool name is the tool's identity, so a `
        + 'client sees one tool and reaches whichever route was registered last.',
        'Give each route its own name, or set agent.toolName on all but one of them.',
      ),
    )
  }
  return results
}

/**
 * RFC 0016 §5.5: a non-read-only tool with neither an authorization capability
 * nor a detected `this.authorize(` fails — authentication is not authorization.
 * No "older server" branch on `capabilities`: a server old enough to omit it
 * cannot emit `agent` at all.
 */
function authorizationFinding(route: AgentRoute): CheckResult | undefined {
  if (readOnlyOf(route)) return undefined

  const key = `agent-route-authorization:${route.keySuffix}`
  const title = `${route.label} agent tool`

  // Presence, not derivability: `mode: 'mixed'` or an `abilityFor` callback
  // leaves the ability unknowable statically, but the chain still authorizes.
  if (route.definition.capabilities?.authorization) return undefined
  if (route.methodInfo && AUTHORIZE_CALL_PATTERN.test(route.methodInfo.body)) return undefined

  const suggestion =
    'Add authorize()/authorizeResource() middleware to the route, or call await this.authorize(ability, ...) '
    + 'in the action.'

  // A body this check never read gets a warn, not the fail: `guren check` has
  // no per-finding ignore config, so a false positive would be unsuppressible.
  if (!route.methodInfo) {
    return check(
      key,
      title,
      'warn',
      route.controllerKey
        ? `Authorization could not be verified: the route's middleware chain carries no authorization `
          + `capability, and ${route.controllerKey} is not among the controller sources this check reads.`
        : 'Authorization could not be verified: the route\'s middleware chain carries no authorization '
          + 'capability, and the handler is an inline function whose body this check does not read.',
      suggestion,
    )
  }

  const authenticated =
    route.definition.capabilities?.authentication?.mode === 'required'
    || AUTH_CALL_PATTERN.test(route.methodInfo.body)

  return check(
    key,
    title,
    'fail',
    authenticated
      ? 'Authenticated but not authorized: the route establishes who the caller is, but nothing decides '
        + 'whether that caller may perform this action. A non-read-only tool hands every authenticated '
        + 'principal — every agent holding any token — the whole action.'
      : 'A non-read-only agent tool with no authorization: neither the middleware chain nor the controller '
        + 'action decides whether the caller may perform this action.',
    `${suggestion} Mark the tool agent: { readOnlyHint: true } only if it truly changes nothing — that `
    + 'claim is itself checked against the action\'s body.',
    route.methodInfo.filePath,
  )
}

/**
 * Annotation honesty for `readOnlyHint` (RFC 0016 §5.5). Read-only is what
 * exempts a route from the authorization rule above, so both the written hint and
 * the GET/QUERY default are checked against the action.
 */
function readOnlyHonestyFinding(route: AgentRoute): CheckResult | undefined {
  if (!readOnlyOf(route)) return undefined

  const override = overridesReadOnly(route)
  const key = `agent-route-annotation:${route.keySuffix}`
  const title = `${route.label} agent tool`
  const suggestion = override
    ? 'Drop readOnlyHint: true, and cover the route with authorize()/authorizeResource() middleware or '
      + 'this.authorize(...) in the action.'
    : `Move the state change to a non-safe method, or declare agent: { readOnlyHint: false } and cover `
      + `${route.label} with authorization.`

  // Only the written claim is chased into an unreadable body: warning on the
  // GET default would fire on every ordinary read route with an unseen controller.
  if (!route.methodInfo) {
    if (!override) return undefined
    return check(
      key,
      title,
      'warn',
      `The route declares readOnlyHint: true on ${route.method}, which exempts it from the authorization `
      + 'rule, and the handler body this claim would be checked against is one this check does not read.',
      suggestion,
    )
  }

  if (!mutatesRecords(route.methodInfo.body)) return undefined

  return check(
    key,
    title,
    'warn',
    override
      ? `The route declares readOnlyHint: true, but ${route.controllerKey} deletes, updates, or `
        + 'force-writes records. Clients read that hint as "safe to call unattended", and it is also what '
        + 'exempts this route from the authorization rule — so the claim is buying the exemption its own '
        + 'body contradicts.'
      : `${route.method} routes are read-only tools by default, but ${route.controllerKey} deletes, `
        + 'updates, or force-writes records. The tool is advertised to agents as safe to call unattended, '
        + 'and the default is also what exempts this route from the authorization rule.',
    suggestion,
    route.methodInfo.filePath,
  )
}

/**
 * The output half of the tier ladder (RFC 0016 §2/§4): any agent route with
 * neither an `output` schema nor a `resource` hint is tier 3, whatever its
 * method. The Inertia finding is the more specific one and suppresses the generic.
 */
function outputFinding(route: AgentRoute): CheckResult | undefined {
  if (describesOutput(route.definition)) return undefined

  const title = `${route.label} agent tool`
  const suggestion =
    'Attach an `output` Zod schema to the route (structuredContent-capable), or declare a `resource` '
    + 'response hint so the tool description can carry the payload type.'

  if (route.methodInfo && INERTIA_CALL_PATTERN.test(route.methodInfo.body)) {
    return check(
      `agent-route-inertia:${route.keySuffix}`,
      title,
      'warn',
      `${route.controllerKey} responds with an Inertia page. An agent surface unwraps that to page.props `
      + 'only because no output schema is advertised, so the tool returns whatever the page happens to '
      + 'pass its component — a shape nothing checks and any UI change can move.',
      suggestion,
      route.methodInfo.filePath,
    )
  }

  return check(
    `agent-route-output:${route.keySuffix}`,
    title,
    'warn',
    'The tool advertises no output shape: the route has neither an `output` schema nor a `resource` '
    + 'response hint, so no outputSchema is derivable and the result reaches the agent as untyped text.',
    suggestion,
  )
}

/**
 * A body-carrying tool whose route declares no `body` schema: the derived
 * inputSchema comes from the route's contracts alone. Body-carrying is
 * `describeMethod()`, which also covers QUERY (RFC 10008). Matching the route's
 * schema identifier against `validateBody(X)` is not attempted — the schema is
 * usually imported under another local name, so it would report phantom drift.
 */
function inputFinding(route: AgentRoute): CheckResult | undefined {
  if (!describeMethod(route.method).bodyCarrying) return undefined
  if (route.definition.schemas?.body) return undefined

  const shared =
    'The route carries no `body` schema, so the tool\'s advertised inputSchema is built from the path and '
    + 'query alone. '

  return check(
    `agent-route-input:${route.keySuffix}`,
    `${route.label} agent tool`,
    'warn',
    shared
    + (route.controllerKey
      ? `An agent cannot see what ${route.controllerKey} expects in the request body, and every call it `
        + 'composes is rejected by the validation inside the action.'
      : 'The handler is an inline function, for which a route body schema is the validation — so nothing '
        + 'tells the agent what to send, and nothing checks what it sends.'),
    route.controllerKey
      ? 'Attach the same Zod schema the action validates with as the route\'s `body` option — it is type '
        + 'information for controller actions, and the one place codegen and the agent surface can read it.'
      : 'Attach a Zod schema as the route\'s `body` option — for an inline handler it is enforced at '
        + 'request time as well as advertised to the agent.',
  )
}

/** Local aliases of this export are followed; a same-named function from elsewhere is not. */
const MCP_PLUGIN_SPECIFIER = '@guren/plugin-mcp'
const MCP_PLUGIN_EXPORT = 'mcpPlugin'

/** What one readable `mcpPlugin({ … })` call says about the approval queue. */
type ApprovalConfigEvidence =
  | { kind: 'configured'; relPath: string }
  | { kind: 'absent'; relPath: string }

/**
 * Whether this app configures an approval queue, judged from the `mcpPlugin({ … })`
 * call that mounts the endpoint. Positive evidence only (the `app-surface.ts` rule):
 * anything unreadable answers `undefined`, since a false positive would be
 * unsuppressible. The key is `AGENT_APPROVAL_CONFIG_KEY` from `@guren/core`, never the
 * literal string: the CLI cannot import `@guren/plugin-mcp`, so a restated name rots silently.
 */
async function scanApprovalConfig(
  cwd: string,
  cache: ParseCache,
): Promise<ApprovalConfigEvidence | undefined> {
  const roots = await listAppRoots(cwd)
  const groups = await Promise.all(
    roots.flatMap((root) => ['config', 'src', 'app'].map((dir) => collectFiles(resolve(root.dir, dir)))),
  )
  const files = groups.flat().filter((file) => !/\.test\.[jt]sx?$/.test(file))

  let absent: ApprovalConfigEvidence | undefined
  for (const filePath of files) {
    // String pre-filter before any parse: almost no source mentions the plugin.
    const source = await cache.source(filePath)
    if (!source || !source.includes(MCP_PLUGIN_EXPORT)) continue
    const parsed = await cache.get(filePath)
    if (!parsed) continue

    const relPath = relative(cwd, filePath).replace(/\\/g, '/')
    const evidence = readMcpPluginCalls(parsed)
    // A configured call anywhere settles it: an app may mount the endpoint twice.
    if (evidence === 'configured') return { kind: 'configured', relPath }
    if (evidence === 'absent') absent ??= { kind: 'absent', relPath }
  }

  return absent
}

/**
 * `'configured'` if any call carries the queue key, `'absent'` if one has
 * readable options without it, `undefined` if none was readable.
 */
function readMcpPluginCalls(parsed: ParsedFile): 'configured' | 'absent' | undefined {
  const locals = new Set<string>()
  for (const declaration of parsed.ast.program.body) {
    if (declaration.type !== 'ImportDeclaration') continue
    if (declaration.source.value !== MCP_PLUGIN_SPECIFIER) continue
    for (const specifier of declaration.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue
      const imported =
        specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
      if (imported === MCP_PLUGIN_EXPORT) locals.add(specifier.local.name)
    }
  }
  if (locals.size === 0) return undefined

  let answer: 'configured' | 'absent' | undefined
  walk(parsed.ast.program, (node) => {
    if (node.type !== 'CallExpression') return
    // Typed once at the seam so everything below is `@babel/types`.
    const call = node as unknown as CallExpression
    const callee = call.callee
    if (callee.type !== 'Identifier' || !locals.has(callee.name)) return

    const argument = call.arguments[0]
    // `mcpPlugin()` with no argument is a readable call with no queue.
    if (!argument) {
      answer ??= 'absent'
      return
    }
    // Read through transparent wrapping: a bare shape test read `{ … } satisfies
    // McpPluginOptions` as unreadable, which silenced the finding entirely.
    const options = objectLiteral(argument)
    if (!options) return

    const properties = options.properties
    const carriesQueue = properties.some(
      (property) =>
        (property.type === 'ObjectProperty' || property.type === 'ObjectMethod')
        && memberKeyName(property) === AGENT_APPROVAL_CONFIG_KEY,
    )
    // A spread makes an absence unreadable; a key literally there is still evidence.
    const spreads = properties.some((property) => property.type === 'SpreadElement')
    if (carriesQueue) answer = 'configured'
    else if (!spreads) answer ??= 'absent'
  })

  return answer
}

/**
 * A route declaring `approval: 'required'` on a server whose App MCP endpoint
 * has no approval queue (RFC 0016 §5.4 item 4). A fail rather than a warn
 * because it is raised only on positive evidence, and the tool is then
 * categorically uncallable. One finding per app, not per route.
 */
function approvalStoreFinding(
  routes: AgentRoute[],
  evidence: ApprovalConfigEvidence | undefined,
): CheckResult | undefined {
  if (!evidence || evidence.kind === 'configured') return undefined

  const gated = routes.filter((route) => route.agent.approval === 'required')
  if (gated.length === 0) return undefined

  return check(
    'agent-route-approval-store',
    'Agent approval queue',
    'fail',
    `${gated.length} route${gated.length === 1 ? '' : 's'} declare approval: 'required' `
    + `(${gated.map((route) => route.toolName ?? route.label).join(', ')}), but the mcpPlugin({ … }) call `
    + `in ${evidence.relPath} configures no ${AGENT_APPROVAL_CONFIG_KEY}. Without a queue there is `
    + 'nowhere to record a pending request, so every call to those tools is refused fail-closed and they '
    + 'are absent from tools/list entirely — the declaration makes them uncallable rather than guarded.',
    `Pass ${AGENT_APPROVAL_CONFIG_KEY}: { store, notify } to mcpPlugin() — store is your own `
    + 'AgentApprovalStore, notify hands the request to whoever approves — or drop '
    + "agent: { approval: 'required' } from those routes.",
    evidence.relPath,
  )
}

// TODO(RFC 0016 §2): the input key-collision rule — a path parameter
// supplemented into the merged input schema colliding with a `query` or
// `body` key — needs the merged schema `deriveAgentTools()` builds, and is
// therefore left to the PR that lands that derivation.

function toAgentRoute(
  definition: RouteDefinition,
  controllerMethods: Map<string, ControllerMethodInfo>,
): AgentRoute | undefined {
  const { agent } = definition
  if (!agent) return undefined

  const method = definition.method.toUpperCase()
  const controllerKey = definition.controller
    ? `${definition.controller.name}.${definition.controller.action}`
    : undefined

  return {
    definition,
    agent,
    method,
    toolName: agent.toolName ?? definition.name,
    label: `${method} ${definition.path}`,
    keySuffix: `${method}:${definition.path}`,
    controllerKey,
    methodInfo: controllerKey ? controllerMethods.get(controllerKey) : undefined,
  }
}

/**
 * Agent-route checks (RFC 0016 §13): the wiring rules for routes declaring
 * `.agent()` metadata. Runs against loaded definitions rather than the routes
 * file's AST, like `checkRouteContracts` — the registered path is the joined one
 * and the metadata may arrive via `resource({ agent })`. Content-activated: an
 * app with no agent routes contributes nothing and scans no controller.
 */
export async function checkAgentRoutes(options: AgentRouteCheckOptions): Promise<CheckResult[]> {
  const { cwd, routesFile = DEFAULT_ROUTES_FILE } = options

  let definitions = options.definitions
  if (!definitions) {
    if (!(await fileExists(cwd, routesFile))) return []

    try {
      definitions = await loadRouteDefinitions(resolve(cwd, routesFile), cwd)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Never swallowed: silence is indistinguishable from an app with no agent tools.
      return [
        check(
          'agent-routes',
          'Agent routes',
          'warn',
          `Skipped: the route graph failed to load: ${message}`,
          'Fix the error, then run: bunx guren check',
          routesFile,
        ),
      ]
    }
  }

  const agentDefinitions = definitions.filter((definition) => definition.agent)
  if (agentDefinitions.length === 0) return []

  // Skipped when every agent route is an inline handler: no body for any rule to read.
  const scan = agentDefinitions.some((definition) => definition.controller)
    ? await parseControllerMethods(cwd, options.cache)
    : EMPTY_CONTROLLER_SCAN

  const routes = agentDefinitions.flatMap((definition) => {
    const route = toAgentRoute(definition, scan.methods)
    return route ? [route] : []
  })

  const results: CheckResult[] = []

  // Reported separately because the per-route could-not-verify message blames
  // the discovery set, not a file that is there and would not open.
  for (const filePath of scan.unreadableFiles) {
    results.push(
      check(
        `agent-route-controller-unreadable:${filePath}`,
        `${filePath} unreadable`,
        'warn',
        `${filePath} could not be read, so any agent route whose action lives there was checked against `
        + 'no body at all.',
        `Check the file's permissions and that it still exists, then re-run: bunx guren check`,
        filePath,
      ),
    )
  }

  // Routes carry a class name alone, so two controllers sharing one make every
  // body-derived verdict unreliable. Narrowed to controllers agent routes name:
  // any other collision changes no verdict here and belongs to `guren audit`.
  const agentControllers = new Set(
    routes.flatMap((route) => (route.definition.controller ? [route.definition.controller.name] : [])),
  )
  for (const collision of scan.collisions.filter((c) => agentControllers.has(c.className))) {
    results.push(
      check(
        `agent-route-controller-collision:${collision.className}`,
        `${collision.className} name collision`,
        'warn',
        `${collision.className} is declared in both ${collision.previousFile} and ${collision.currentFile}. `
        + 'Agent-route verdicts drawn from a controller body — authorization evidence, Inertia responses — '
        + `use whichever file was scanned last, so the verdict for any ${collision.className} route may `
        + 'describe the other class.',
        `Rename one of the two ${collision.className} classes, then re-run: bunx guren check`,
      ),
    )
  }

  results.push(...duplicateFindings(routes))

  // Only asked when a route declares approval — the scan reads every app source.
  if (routes.some((route) => route.agent.approval === 'required')) {
    const approval = approvalStoreFinding(
      routes,
      await scanApprovalConfig(cwd, options.cache ?? new ParseCache()),
    )
    if (approval) results.push(approval)
  }

  for (const route of routes) {
    // At most one naming finding per route, first applicable wins: the three
    // rules describe one defect with one fix, renaming the route.
    const nameResult = nameFinding(route) ?? toolNameFinding(route) ?? reservedNameFinding(route)
    if (nameResult) results.push(nameResult)

    const authorization = authorizationFinding(route)
    if (authorization) results.push(authorization)

    const honesty = readOnlyHonestyFinding(route)
    if (honesty) results.push(honesty)

    const output = outputFinding(route)
    if (output) results.push(output)

    const input = inputFinding(route)
    if (input) results.push(input)
  }

  if (results.length > 0) return results

  return [
    check(
      'agent-routes',
      'Agent routes',
      'pass',
      `${routes.length} agent-exposed route${routes.length === 1 ? '' : 's'} checked: every tool name is `
      + 'legal, unreserved and unique, every non-read-only tool carries authorization evidence, every declared '
      + 'readOnlyHint holds against the action, every approval-gated tool has a queue to record into, and '
      + 'every route declares the schemas a tool is derived from. Nothing here validates the derived tools '
      + 'themselves, or any behaviour outside the controller bodies this check reads.',
    ),
  ]
}

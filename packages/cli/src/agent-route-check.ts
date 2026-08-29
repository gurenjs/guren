import { resolve } from 'node:path'
import type { AgentRouteMetadata, RouteDefinition } from '@guren/core'
import { check, type CheckResult } from './check-result'
import { parseControllerMethods, type ControllerMethodInfo } from './controller-methods'
import { fileExists } from './discovery'
import { describeMethod } from './http-methods'
import { DEFAULT_ROUTES_FILE, loadRouteDefinitions } from './load-routes'

export interface AgentRouteCheckOptions {
  cwd: string
  /** Routes entry file, POSIX-relative to `cwd`. Defaults to `routes/web.ts`. */
  routesFile?: string
  /**
   * Definitions to check instead of loading them. A test seam, not a
   * shared-load path: the one production caller (`runCheck`) deliberately does
   * not pass it, because a second `loadRouteDefinitions()` in the same process
   * re-runs only the registrar — the module graph is already evaluated and is
   * never re-evaluated (see `load-routes.ts`).
   */
  definitions?: RouteDefinition[]
}

/**
 * The MCP tool-name grammar (SEP-986). Dots are permitted, which is why a
 * route name is used verbatim as the tool name — see RFC 0016 §1.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/**
 * The methods whose tools default to `readOnlyHint: true` (RFC 0016 §1).
 *
 * Deliberately narrower than `describeMethod().safe`, which also holds HEAD
 * and OPTIONS: those are not tool-shaped verbs, and counting them as
 * read-only would exempt such a route from the authorization rule below on
 * the strength of a default nobody wrote. The two agree on everything an
 * agent route realistically registers.
 */
const AGENT_READ_ONLY_METHODS = new Set(['GET', 'QUERY'])

/**
 * `this.authorize(...)` — the call that throws a 403. `this.can(...)` is
 * deliberately not evidence: it returns a boolean and enforces nothing, the
 * same distinction `guren audit` already draws between `auth.userOrFail()`
 * and `auth.check()`. The `this.` prefix is required because the member is
 * protected, so a call through anything else is a different API.
 */
const AUTHORIZE_CALL_PATTERN = /\bthis\s*\.\s*authorize\s*(?:<[^()]*>)?\s*\(/

/** Authentication that rejects the request — not authorization. See RFC 0016 §5.5. */
const AUTHENTICATE_CALL_PATTERN = /\bauth\s*\.\s*userOrFail\s*(?:<[^>]*>)?\s*\(/

/** An Inertia page response, which carries no JSON schema an agent could read. */
const INERTIA_CALL_PATTERN = /\bthis\s*\.\s*inertia\s*(?:<[^()]*>)?\s*\(/

interface AgentRoute {
  definition: RouteDefinition
  agent: AgentRouteMetadata
  method: string
  /** The tool's identity: `toolName ?? name`. Undefined when the route has no name. */
  toolName?: string
  /** Human label for finding titles. */
  label: string
  /** Stable finding-key suffix, unique per route even when the tool name is not. */
  keySuffix: string
  controllerKey?: string
  methodInfo?: ControllerMethodInfo
}

function readOnlyOf(route: AgentRoute): boolean {
  return route.agent.readOnlyHint ?? AGENT_READ_ONLY_METHODS.has(route.method)
}

/** Whether the route advertises any output shape an agent can read (RFC 0016 §2). */
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
 * One finding per collision group rather than per route: two routes sharing a
 * tool name are one defect, and the reader needs both sides of it named.
 */
function duplicateFindings(routes: AgentRoute[]): CheckResult[] {
  const byToolName = new Map<string, AgentRoute[]>()
  for (const route of routes) {
    if (route.toolName === undefined) continue
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
 * RFC 0016 §5.5: a non-read-only tool with neither an authorization
 * capability nor a detected `this.authorize(` fails — authentication is not
 * authorization.
 *
 * `capabilities` needs no "older server" branch here the way
 * `authMiddlewareVerdict` does: a server old enough to omit the field is far
 * too old to emit `agent` at all, so a definition that reached this function
 * came from a router that stamps capabilities.
 */
function authorizationFinding(route: AgentRoute): CheckResult | undefined {
  if (readOnlyOf(route)) return undefined

  const key = `agent-route-authorization:${route.keySuffix}`
  const title = `${route.label} agent tool`

  // Present, not derivable: `mode: 'mixed'` or an `abilityFor` callback makes
  // the *ability* unknowable statically, but the chain still authorizes. The
  // question this rule asks is whether anything authorizes at all.
  if (route.definition.capabilities?.authorization) return undefined
  if (route.methodInfo && AUTHORIZE_CALL_PATTERN.test(route.methodInfo.body)) return undefined

  // A controller whose source could not be read is reported rather than
  // failed: the action may well authorize, and unlike `guren audit` this
  // command has no per-finding ignore config to suppress a false positive
  // that only moving the file could fix.
  if (route.controllerKey && !route.methodInfo) {
    return check(
      key,
      title,
      'warn',
      `Authorization could not be verified: ${route.controllerKey} is not among the controller sources `
      + 'this check can read, and the route\'s middleware carries no authorization capability.',
      'Wrap the route in authorize()/authorizeResource() middleware, or call this.authorize(...) in the action.',
    )
  }

  const authenticated =
    route.definition.capabilities?.authentication?.mode === 'required'
    || Boolean(route.methodInfo && AUTHENTICATE_CALL_PATTERN.test(route.methodInfo.body))

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
    'Add authorize()/authorizeResource() middleware to the route, or call await this.authorize(ability, ...) '
    + 'in the action. Mark the tool agent: { readOnlyHint: true } only if it truly changes nothing.',
    route.methodInfo?.filePath,
  )
}

/**
 * The output half of the tier ladder (RFC 0016 §2/§4). The Inertia finding is
 * the more specific of the two and suppresses the generic one, so a read-only
 * page route reports once rather than twice.
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

  if (!readOnlyOf(route)) return undefined

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
 * inputSchema is built from the route's contracts, so a body the controller
 * validates internally never reaches the agent's view of the tool.
 *
 * Body-carrying is `describeMethod()`, shared with `guren audit`, rather than
 * a hand-listed POST/PUT/PATCH — that also covers QUERY (RFC 10008) and is
 * fail-closed on custom verbs.
 *
 * Best-effort matching of the route's body schema identifier against the
 * `validateBody(X)` call in the action is deliberately not attempted: the
 * schema is usually imported under a different local name, so the comparison
 * would report drift that isn't there.
 */
function inputFinding(route: AgentRoute): CheckResult | undefined {
  if (!describeMethod(route.method).bodyCarrying) return undefined
  if (!route.controllerKey) return undefined
  if (route.definition.schemas?.body) return undefined

  return check(
    `agent-route-input:${route.keySuffix}`,
    `${route.label} agent tool`,
    'warn',
    `The route carries no \`body\` schema, so the tool's advertised inputSchema is built from the path and `
    + `query alone. An agent cannot see what ${route.controllerKey} expects in the request body, and every `
    + 'call it makes is rejected by the validation inside the action.',
    'Attach the same Zod schema the action validates with as the route\'s `body` option — it is type '
    + 'information for controller actions, and the one place codegen and the agent surface can read it.',
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
 * Agent-route checks (RFC 0016 §13): the wiring rules for routes that declare
 * `.agent()` metadata — the tool name is legal and unique, a non-read-only
 * tool is covered by authorization rather than merely authentication, and the
 * schemas an agent reads actually exist.
 *
 * Runs against loaded definitions rather than the routes file's AST for the
 * same reasons `checkRouteContracts` does: the registered path is the joined
 * one (group prefixes, `resource()` expansions), and the metadata may arrive
 * through `resource({ agent })` or a chained `.agent()` rather than a literal
 * in the routes file.
 *
 * Content-activated: an app with no agent routes contributes nothing, and the
 * controller sources are not even scanned in that case — which is every app
 * until one opts in.
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
      // A load failure is reported, never swallowed: staying silent here is
      // indistinguishable from an app that exposes no agent tools.
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

  if (!definitions.some((definition) => definition.agent)) return []

  const { methods, collisions } = await parseControllerMethods(cwd)
  const routes = definitions
    .map((definition) => toAgentRoute(definition, methods))
    .filter((route): route is AgentRoute => route !== undefined)

  const results: CheckResult[] = []

  // Two controllers sharing a class name make every body-derived verdict
  // below unreliable — routes carry the class name alone, so an authorize()
  // in one file can clear a route belonging to the other. `guren audit` fails
  // on the collision itself; here it is reported as the reason the agent
  // verdicts cannot be trusted.
  for (const collision of collisions) {
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

  for (const route of routes) {
    const nameResult = nameFinding(route)
    if (nameResult) {
      // The tool-name grammar has nothing to test on a route with no name;
      // reporting both would name one defect twice.
      results.push(nameResult)
    } else {
      const toolNameResult = toolNameFinding(route)
      if (toolNameResult) results.push(toolNameResult)
    }

    const authorization = authorizationFinding(route)
    if (authorization) results.push(authorization)

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
      + 'legal and unique, every non-read-only tool is covered by authorization, and every tool advertises '
      + 'the schemas an agent reads.',
    ),
  ]
}

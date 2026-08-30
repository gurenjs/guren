import { resolve } from 'node:path'
import type { AgentRouteMetadata, RouteDefinition } from '@guren/core'
import { check, type CheckResult } from './check-result'
import {
  mutatesRecords,
  parseControllerMethods,
  AUTHORIZE_CALL_PATTERN,
  AUTH_CALL_PATTERN,
  INERTIA_CALL_PATTERN,
  type ControllerMethodInfo,
} from './controller-methods'
import { fileExists } from './discovery'
import { describeMethod } from './http-methods'
import { DEFAULT_ROUTES_FILE, loadRouteDefinitions } from './load-routes'
import type { ParseCache } from './parse-cache'

export interface AgentRouteCheckOptions {
  cwd: string
  /** Routes entry file, POSIX-relative to `cwd`. Defaults to `routes/web.ts`. */
  routesFile?: string
  /**
   * Definitions to check instead of loading them. `runCheck` passes the graph
   * it already loaded for the route-contract checks, so one `guren check` run
   * loads it once; tests pass hand-built definitions. Absent, this loads its
   * own.
   */
  definitions?: RouteDefinition[]
  /**
   * Parse cache to read controller sources through. `runCheck` passes its
   * own, so the files earlier checks already parsed are not parsed twice.
   */
  cache?: ParseCache
}

/**
 * The MCP tool-name grammar (SEP-986). Dots are permitted, which is why a
 * route name is used verbatim as the tool name — see RFC 0016 §1.
 *
 * Consolidation follow-up, like {@link AGENT_READ_ONLY_METHODS}: the
 * derivation layer (`deriveAgentTools`) has to know this grammar too. RFC
 * 0016 §1 is the shared source until one of the two can import the other —
 * do not fork the pattern in the meantime.
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

/**
 * Whether `readOnlyHint: true` was *written* rather than inherited from the
 * method — the declaration that exempts a mutating route from the
 * authorization rule below.
 */
function overridesReadOnly(route: AgentRoute): boolean {
  return route.agent.readOnlyHint === true && !AGENT_READ_ONLY_METHODS.has(route.method)
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
 *
 * A name the grammar rejects is skipped here: it is already failing under its
 * own rule, and renaming it is the fix for both, so reporting it twice more
 * as a collision would spend three findings on one defect.
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

  const suggestion =
    'Add authorize()/authorizeResource() middleware to the route, or call await this.authorize(ability, ...) '
    + 'in the action.'

  // A handler body this check never read cannot be failed over. Two shapes
  // reach here: a controller action whose source is not among the files
  // discovered (moved out of app/Http/Controllers, unparseable, or supplied
  // by a package), and an inline handler, whose body is a closure in the
  // routes file that this check does not read at all. Both get a warn rather
  // than the fail — unlike `guren audit`, this command has no per-finding
  // ignore config, so a false positive here would be unsuppressible — and
  // both say which half is actually known: the middleware chain.
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
 * Annotation honesty for `readOnlyHint` (RFC 0016 §5.5), the counterpart to
 * `guren audit`'s `destructiveHint` rule.
 *
 * Two routes are read-only tools, and both are checked against the action:
 *
 * - An explicit `readOnlyHint: true` on a mutating verb. This is the one
 *   declaration that *exempts* a route from the authorization rule above, so
 *   leaving it unchecked would make the exemption self-service — writing the
 *   hint would be enough to silence the failure it was meant to answer.
 * - A GET or QUERY route, which inherits the same read-only default with the
 *   same exemption. Nobody wrote the claim, but a GET that deletes records is
 *   advertised to agents as safe to call unattended either way, and the
 *   safe-verb contract it breaks is HTTP's before it is MCP's.
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

  // Only the written claim is chased into an unreadable body: an unverifiable
  // *default* on a GET would fire on every ordinary read route whose
  // controller this check cannot see, which is noise about nothing declared.
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
 * The output half of the tier ladder (RFC 0016 §2/§4): *any* agent route with
 * neither an `output` schema nor a `resource` hint is tier 3, whatever its
 * method — a write tool whose result an agent cannot read is no better off
 * than a read tool.
 *
 * The Inertia finding is the more specific of the two and suppresses the
 * generic one, so a page route reports once rather than twice.
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
 * inputSchema is built from the route's contracts, so a body the controller
 * validates internally never reaches the agent's view of the tool.
 *
 * Body-carrying is `describeMethod()`, shared with `guren audit`, rather than
 * a hand-listed POST/PUT/PATCH — that also covers QUERY (RFC 10008) and is
 * fail-closed on custom verbs.
 *
 * Inline handlers are covered too, and are the worse case: for them a route
 * `body` schema is *runtime-enforced*, so its absence means nothing validates
 * the payload either — the agent guesses at a shape the app never checks.
 *
 * Best-effort matching of the route's body schema identifier against the
 * `validateBody(X)` call in the action is deliberately not attempted: the
 * schema is usually imported under a different local name, so the comparison
 * would report drift that isn't there.
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

  // Routes first, controllers only if one of them names a controller: an app
  // whose agent routes are all inline handlers has no body for any rule here
  // to read, so scanning every controller in it would buy nothing.
  const bare = definitions
    .map((definition) => toAgentRoute(definition, new Map()))
    .filter((route): route is AgentRoute => route !== undefined)

  const scan = bare.some((route) => route.controllerKey)
    ? await parseControllerMethods(cwd, options.cache)
    : { methods: new Map<string, ControllerMethodInfo>(), collisions: [], unreadableFiles: [] }

  const routes = bare.map((route) => ({
    ...route,
    methodInfo: route.controllerKey ? scan.methods.get(route.controllerKey) : undefined,
  }))

  const results: CheckResult[] = []

  // A controller file that could not be read at all. The routes naming it
  // already take the could-not-verify path, but that message blames the
  // discovery set ("not among the controller sources this check reads") when
  // the real cause is a file right where it should be that would not open.
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

  // Two controllers sharing a class name make every body-derived verdict
  // below unreliable — routes carry the class name alone, so an authorize()
  // in one file can clear a route belonging to the other. `guren audit` fails
  // on the collision itself; here it is reported as the reason the agent
  // verdicts cannot be trusted.
  //
  // Narrowed to the controllers agent routes actually name: a collision
  // between two classes with no agent route between them changes no verdict
  // this check draws, and reporting it here would be this check answering for
  // the audit's rule.
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
      + 'legal and unique, every non-read-only tool carries authorization evidence, every declared '
      + 'readOnlyHint holds against the action, and every route declares the schemas a tool is derived '
      + 'from. Nothing here validates the derived tools themselves, or any behaviour outside the '
      + 'controller bodies this check reads.',
    ),
  ]
}

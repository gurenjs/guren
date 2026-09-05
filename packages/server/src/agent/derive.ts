/**
 * Turns registered route definitions into agent tools (RFC 0016 §2).
 *
 * The *one* derivation: the runtime protocol adapters and the CLI's
 * `.guren/agents.gen.ts` both call it, so a generated manifest and a live MCP
 * server can differ only in description richness. Nothing is restated by hand.
 * Total — an inexpressible contract becomes a warning plus a deterministic
 * result, and `guren check` turns those warnings into a failing build. Opt-in —
 * a route becomes a tool only by declaring `.agent()` *and* carrying a name.
 */
import type { ResourceResponseShape, RouteDefinition } from '../mvc/Router'
import { extractPathParamNames } from '../internal/route-path'
import { resourceAbilityForMethod } from '../authorization/middleware'
import {
  type JsonSchemaObject,
  readObjectSchema,
  toJsonSchema,
} from '../internal/zod-json-schema'

/**
 * A JSON Schema 2020-12 object as an agent tool advertises it — an alias of the
 * shared walker's type, which `@guren/openapi` aliases the same way, so one
 * definition serves every surface.
 */
export type AgentToolSchema = JsonSchemaObject

/**
 * MCP `ToolAnnotations`, resolved to explicit values so no consumer re-applies
 * a default and `guren check`'s annotation-honesty rule has one concrete claim
 * to check. Hints for client UX, not enforcement.
 */
export interface DerivedAgentToolAnnotations {
  /** The tool does not modify its environment. */
  readOnlyHint: boolean
  /** The tool may perform destructive updates. Meaningful only when not read-only. */
  destructiveHint: boolean
  /** Repeat calls with the same arguments have no additional effect. */
  idempotentHint: boolean
}

/** Protocol surfaces a tool appears on. Both resolved; unset means exposed. */
export interface DerivedAgentToolExposure {
  mcp: boolean
  webMcp: boolean
}

export interface DerivedAgentTool {
  /** Tool identity: `agent.toolName` when given, otherwise the route name, verbatim. */
  toolName: string
  /** The route name this tool was derived from. Equal to `toolName` unless overridden. */
  routeName: string
  /** Uppercased HTTP method the tool dispatches to. */
  method: string
  /** Route path pattern, `:param` tokens intact. */
  path: string
  /**
   * `agent.description`, else the route's OpenAPI `description`, else its
   * `summary`. Absent when the route declares none — nothing is invented here.
   */
  description?: string
  /** Merged `params` + `query` + `body`, object root (MCP requires one). */
  inputSchema: AgentToolSchema
  /**
   * Which contract each advertised input property came from — the inverse of
   * the merge, for the adapter that rebuilds the HTTP request from a flat tool
   * call. The schema alone cannot answer it, and an adapter guessing by method
   * would put a POST route's `query` keys in the body, where `validateQuery`
   * never looks.
   */
  inputSources: Record<string, AgentToolInputSource>
  /**
   * True when the route's `body` schema was not an object and therefore nests
   * under a single `body` property. The adapter must then send `arguments.body`
   * *as* the HTTP body: the flat rebuild would post `{ body: [...] }` to a
   * route that validates an array.
   */
  inputBodyNested: boolean
  /** Present only when the route binds an `output` schema — the one shape validated at runtime. */
  outputSchema?: AgentToolSchema
  /**
   * The route's `resource` response hint, as class names — carried rather than
   * resolved: the payload type behind them exists only in the CLI's AST
   * extraction. Absent when the route declares no hint, and deliberately also
   * whenever it declares an `output` schema, whether or not the walker could
   * render it — the declaration is what the runtime validates against.
   */
  resource?: ResourceResponseShape
  annotations: DerivedAgentToolAnnotations
  /**
   * The policy ability guarding this route, when its middleware chain stamped
   * one unambiguously. Absent means "not statically derivable", never "not
   * authorized" — a check reads the absence, it does not assume a verdict.
   */
  authorization?: { ability: string }
  /** Declared verbatim: invocations require server-side approval. */
  approval?: 'required'
  /** Declared verbatim: argument fields masked in agent audit logs. */
  redact?: string[]
  expose: DerivedAgentToolExposure
  /**
   * What could not be expressed while deriving *this* tool, unprefixed. The
   * same lines appear prefixed in {@link DeriveAgentToolsResult.warnings};
   * attributing by parsing the prefix back off would couple every consumer to a
   * message format nothing states.
   */
  warnings: string[]
}

export interface DeriveAgentToolsResult {
  tools: DerivedAgentTool[]
  /**
   * Everything the derivation could not express, one line each, prefixed with
   * the tool (or the route). Non-fatal by construction. Per-tool lines are also
   * on the tool itself, which is what a consumer needing attribution reads.
   */
  warnings: string[]
}

/** HTTP methods whose semantics are read-only, per the MCP annotation defaults. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'QUERY'])

/** HTTP methods that are idempotent whether or not they are read-only. */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'QUERY', 'PUT', 'DELETE'])

/**
 * Where a merged input property came from — collision reporting inside the
 * merge, request reconstruction outside it. `params` and `path` both mean URL
 * substitution to an adapter; they stay distinct so a warning names the schema
 * the author actually wrote.
 */
export type AgentToolInputSource = 'params' | 'path' | 'query' | 'body'

type InputSource = AgentToolInputSource

interface MergedInput {
  properties: Record<string, AgentToolSchema>
  required: Set<string>
  /** Property name → the source that currently owns it. */
  owner: Map<string, InputSource>
}

/**
 * Derive the agent tools a set of route definitions exposes.
 *
 * @param definitions Registered routes, as `Router.definitions()` hands them out.
 */
export function deriveAgentTools(definitions: RouteDefinition[]): DeriveAgentToolsResult {
  const tools: DerivedAgentTool[] = []
  const warnings: string[] = []
  const claimed = new Map<string, DerivedAgentTool>()

  for (const definition of definitions) {
    const agent = definition.agent
    if (!agent) continue

    const method = definition.method.toUpperCase()
    const where = `${method} ${definition.path}`

    // A tool's name is its identity, and the route name is where it comes from:
    // `toolName` overrides the *spelling*, not the requirement, so a manifest
    // entry and a URL generator can never name different routes. A warning here
    // rather than the failure `guren check` reports — a router mid-edit boots.
    if (!definition.name) {
      warnings.push(
        `${where}: declares agent metadata but has no route name, so it is not exposed as a tool. `
          + 'Chain .name() on the route — the tool name is its identity.',
      )
      continue
    }

    const routeName = definition.name
    const toolName = agent.toolName ?? routeName

    // Two routes claiming one tool name is a conflict, not a merge: the
    // manifest is keyed by name, and an adapter registering the second would
    // throw or shadow the first. First registration wins so the result is
    // deterministic, and the loser is named. Settled *before* the schemas are
    // walked, or the loser's discarded warnings would resurface later as new.
    const existing = claimed.get(toolName)
    if (existing) {
      warnings.push(
        `${toolName}: ${where} (route "${routeName}") claims a tool name already derived from `
          + `${existing.method} ${existing.path} (route "${existing.routeName}") — the later route is not `
          + 'exposed. Give one of them a distinct agent toolName.',
      )
      continue
    }

    const toolWarnings: string[] = []
    const readOnlyHint = agent.readOnlyHint ?? READ_ONLY_METHODS.has(method)
    const input = buildInputSchema(definition, method, toolWarnings)
    const tool: DerivedAgentTool = {
      toolName,
      routeName,
      method,
      path: definition.path,
      description: agent.description ?? definition.description ?? definition.summary,
      inputSchema: input.schema,
      inputSources: input.sources,
      inputBodyNested: input.nestedBody,
      outputSchema: buildOutputSchema(definition, method, toolWarnings),
      // Declared, not derived — see the field's own doc for why an
      // unrepresentable `output` must still suppress the hint.
      resource: definition.schemas?.output ? undefined : definition.resource,
      annotations: {
        readOnlyHint,
        // MCP's default for a non-read-only tool is `true`; declaring `false`
        // is the strong claim "additive updates only", which `guren check`
        // verifies against the controller body.
        destructiveHint: agent.destructiveHint ?? !readOnlyHint,
        idempotentHint: agent.idempotentHint ?? IDEMPOTENT_METHODS.has(method),
      },
      authorization: deriveAuthorization(definition, method),
      approval: agent.approval,
      redact: agent.redact ? [...agent.redact] : undefined,
      expose: {
        mcp: agent.expose?.mcp ?? true,
        webMcp: agent.expose?.webMcp ?? true,
      },
      warnings: toolWarnings,
    }

    claimed.set(toolName, tool)
    tools.push(tool)
    for (const warning of toolWarnings) {
      warnings.push(`${toolName}: ${warning}`)
    }
  }

  return { tools, warnings }
}

/**
 * `params` + `query` + `body` as one object schema, which is what MCP requires
 * of a tool input; the namespaced `{ params, query, body }` alternative is
 * recorded in the RFC as rejected. Ordered params → path supplements → query →
 * body; a later source wins a collision with a warning, and a path parameter is
 * forced required afterwards — the URL cannot be built without it.
 */
interface BuiltInput {
  schema: AgentToolSchema
  sources: Record<string, AgentToolInputSource>
  nestedBody: boolean
}

function buildInputSchema(
  definition: RouteDefinition,
  method: string,
  warnings: string[],
): BuiltInput {
  const label = `${method} ${definition.path}`
  // Null-prototype: a path parameter may legally be named `__proto__`
  // (`/posts/:__proto__`), and assigning that key on a plain `{}` invokes the
  // prototype setter instead of defining a property, so the argument would
  // vanish from the advertised schema.
  const merged: MergedInput = {
    properties: Object.create(null) as Record<string, AgentToolSchema>,
    required: new Set(),
    owner: new Map(),
  }
  const pathParamNames = extractPathParamNames(definition.path)

  const paramsDetails = definition.schemas?.params
    ? readObjectSchema(definition.schemas.params, warnings, `${label} params`, 'input')
    : undefined
  if (paramsDetails) {
    mergeProperties(merged, paramsDetails.properties, paramsDetails.required, 'params', warnings)
  }

  // Path parameters the `params` schema does not describe are still arguments
  // the caller has to supply — the same supplementation `@guren/openapi`
  // applies, off the same lexer, so both surfaces agree `/files/:name*` is one
  // parameter named `name*`. Shared known limitation: Hono's optional modifier
  // (`:id?`) is lexed away and advertised as required; fix it in the lexer.
  const supplements: Record<string, AgentToolSchema> = Object.create(null)
  const supplementRequired = new Set<string>()
  for (const name of pathParamNames) {
    if (merged.owner.has(name)) continue
    supplements[name] = { type: 'string' }
    supplementRequired.add(name)
  }
  mergeProperties(merged, supplements, supplementRequired, 'path', warnings)

  const queryDetails = definition.schemas?.query
    ? readObjectSchema(definition.schemas.query, warnings, `${label} query`, 'input')
    : undefined
  if (queryDetails) {
    mergeProperties(merged, queryDetails.properties, queryDetails.required, 'query', warnings)
  }

  let nestedBody = false
  const body = definition.schemas?.body
    ? toJsonSchema(definition.schemas.body, warnings, `${label} body`, 'input')
    : undefined
  if (body) {
    // An object body's properties merge in flat; anything else nests under
    // `body`, because a tool input has to have an object root. `properties`
    // rather than `type === 'object'` is the test: a `z.record()` renders as an
    // object with `additionalProperties` and no properties.
    if (body.type === 'object' && body.properties) {
      mergeProperties(merged, body.properties, new Set(body.required ?? []), 'body', warnings)
    } else {
      // Required: the route binds a body schema, so the endpoint validates one.
      // A schema permitting omission looks identical here — the walker sees
      // through `.optional()` — and claiming it optional would advertise a call
      // the route rejects.
      mergeProperties(merged, { body }, new Set(['body']), 'body', warnings)
      nestedBody = true
    }
  }

  // Applied last so it outranks every schema that had an opinion: a path
  // parameter is part of the URL, and a request cannot be built without it. A
  // `params` schema declaring `id` optional describes the *type* of that
  // argument, not whether the caller may omit it.
  for (const name of pathParamNames) {
    if (name in merged.properties) merged.required.add(name)
  }

  const required = Array.from(merged.required)
  // Accumulated on a null prototype for the same `__proto__` reason as
  // `merged.properties`, then spread onto a normal object on the way out.
  const sources = Object.create(null) as Record<string, AgentToolInputSource>
  for (const [name, source] of merged.owner) {
    sources[name] = source
  }

  return {
    schema: {
      type: 'object',
      // Copied onto a normal object: `merged.properties` has a null prototype,
      // which a consumer calling `hasOwnProperty` on the schema would not expect.
      properties: { ...merged.properties },
      ...(required.length > 0 ? { required } : {}),
    },
    sources: { ...sources },
    nestedBody,
  }
}

/**
 * Fold one source's properties into the merge. A collision replaces both the
 * property *and* its required-ness — carrying a losing source's `required`
 * forward would demand a key the advertised schema does not describe.
 */
function mergeProperties(
  merged: MergedInput,
  properties: Record<string, AgentToolSchema>,
  required: ReadonlySet<string>,
  source: InputSource,
  warnings: string[],
): void {
  for (const [name, schema] of Object.entries(properties)) {
    const previous = merged.owner.get(name)
    if (previous) {
      warnings.push(
        `input key "${name}" is declared by both the ${previous} and the ${source} schema; `
          + `the ${source} definition wins. Rename one — merged tool input has one namespace.`,
      )
    }
    merged.properties[name] = schema
    merged.owner.set(name, source)
    merged.required.delete(name)
    if (required.has(name)) merged.required.add(name)
  }
}

/**
 * The route's `output` schema — the only response shape validated at runtime,
 * so advertising it costs no new machinery. A `resource` hint is the next rung
 * of RFC 0016's ladder and is CLI-only: the type text behind its class names
 * exists solely in the CLI's AST extraction.
 */
function buildOutputSchema(
  definition: RouteDefinition,
  method: string,
  warnings: string[],
): AgentToolSchema | undefined {
  const output = definition.schemas?.output
  if (!output) return undefined
  return toJsonSchema(output, warnings, `${method} ${definition.path} response`, 'output')
}

/**
 * The ability a route's middleware chain checks, when the stamped capability
 * says so unambiguously (RFC 0007's `MiddlewareCapabilities.authorization`).
 * Everything else is omitted rather than guessed, so absence means
 * "undetermined" — which is what lets `guren check`'s "authn is not authz" rule
 * fail closed on it instead of reading a name that was never checked.
 */
function deriveAuthorization(
  definition: RouteDefinition,
  method: string,
): { ability: string } | undefined {
  const authorization = definition.capabilities?.authorization
  if (!authorization) return undefined

  if (authorization.resource) {
    // `authorizeResourceMiddleware` resolves its ability per request. Only the
    // built-in verb map is derivable, and only through the function that owns
    // it — restating the table here is how a tool comes to advertise an ability
    // the middleware stopped checking.
    if (!authorization.resource.fromMethodMap) return undefined
    if (authorization.abilities.length > 0 || authorization.mode !== 'all') return undefined
    const ability = resourceAbilityForMethod(method)
    return ability ? { ability } : undefined
  }

  if (authorization.abilities.length === 1 && authorization.mode === 'all') {
    return { ability: authorization.abilities[0]! }
  }

  return undefined
}

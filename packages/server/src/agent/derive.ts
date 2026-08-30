/**
 * Turns registered route definitions into agent tools (RFC 0016 §2).
 *
 * This is the *one* derivation. The runtime protocol adapters and the CLI's
 * `.guren/agents.gen.ts` both call it, so a generated manifest and a live MCP
 * server can differ only in description richness — never in schemas, names, or
 * exposure. Nothing here is restated by hand: the input schema comes from the
 * route's own `params`/`query`/`body` contracts through the shared Zod → JSON
 * Schema walker, the output schema from `output`, the ability from the
 * authorization capability its middleware chain stamped.
 *
 * Two properties this function keeps deliberately:
 *
 * - **Total.** Nothing throws and nothing is silently dropped for being
 *   malformed. A contract this cannot express becomes a warning plus a
 *   deterministic result, because the same call has to serve a dev server, a
 *   codegen step, and a production adapter. `guren check` is what turns those
 *   warnings into a failing build (PR-1c).
 * - **Opt-in.** A route becomes a tool only by declaring `.agent()` *and*
 *   carrying a name. Auto-exposing endpoints is the anti-pattern RFC 0016
 *   opens by rejecting.
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
 * A JSON Schema 2020-12 object as an agent tool advertises it. An alias of the
 * shared walker's type rather than a second definition — OpenAPI 3.1's Schema
 * Object is the same dialect, and `@guren/openapi` aliases it the same way, so
 * one definition serves every surface. The name exists so the internal module
 * is not the one a consumer has to import.
 */
export type AgentToolSchema = JsonSchemaObject

/**
 * MCP `ToolAnnotations`, resolved to explicit values — a consumer never has to
 * re-apply a default, and `guren check`'s annotation-honesty rule has one
 * concrete claim to check the controller against.
 *
 * These are hints for client UX, not enforcement. Authorization lives in
 * policies, scopes, and the approval queue.
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
   * `summary`. Absent when the route declares none — nothing is invented here;
   * the CLI appends resource type text at codegen time, and `guren check`
   * warns about a tool with no description at all.
   */
  description?: string
  /** Merged `params` + `query` + `body`, object root (MCP requires one). */
  inputSchema: AgentToolSchema
  /** Present only when the route binds an `output` schema — the one shape validated at runtime. */
  outputSchema?: AgentToolSchema
  /**
   * The route's `resource` response hint, as class names — RFC 0016's second
   * output rung, carried rather than resolved. `definitions()` has only the
   * names; the payload type behind them exists solely in the CLI's AST
   * extraction, which is why codegen enriches the description from this and
   * the runtime does not.
   *
   * Absent when the route declares no hint — and, deliberately, whenever the
   * route *declares* an `output` schema, whether or not the walker could
   * render it. The declaration is what the runtime validates against, so it
   * outranks the hint; carrying both would leave two descriptions of one
   * response with nothing keeping them in agreement, and a route whose
   * `output` the walker cannot express would advertise the *unvalidated* one
   * while the enforced contract silently vanished.
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
   * same lines appear in {@link DeriveAgentToolsResult.warnings} prefixed with
   * the tool name; that aggregate is for printing, this field is for anything
   * that needs to know which tool a warning belongs to. Attributing by parsing
   * the prefix back off would couple every consumer to a message format
   * nothing states. Empty for a tool that derived cleanly.
   */
  warnings: string[]
}

export interface DeriveAgentToolsResult {
  tools: DerivedAgentTool[]
  /**
   * Everything the derivation could not express, one line each, prefixed with
   * the tool (or the route, for a route that could not become one). Non-fatal
   * by construction — see the module header. Per-tool lines are also on the
   * tool itself ({@link DerivedAgentTool.warnings}), which is what a consumer
   * needing attribution should read.
   */
  warnings: string[]
}

/** HTTP methods whose semantics are read-only, per the MCP annotation defaults. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'QUERY'])

/** HTTP methods that are idempotent whether or not they are read-only. */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'QUERY', 'PUT', 'DELETE'])

/** Where a merged input property came from, for collision reporting. */
type InputSource = 'params' | 'path' | 'query' | 'body'

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

    // A tool's name is its identity, and the route name is where that identity
    // comes from. `toolName` overrides the *spelling*, not the requirement:
    // a route with `agent.toolName` and no `.name()` is still not a tool, so
    // that a manifest entry and a URL generator can never name different
    // routes. `guren check` reports this as a failure (PR-1c); here it is a
    // warning, because a router mid-edit must still boot.
    if (!definition.name) {
      warnings.push(
        `${where}: declares agent metadata but has no route name, so it is not exposed as a tool. `
          + 'Chain .name() on the route — the tool name is its identity.',
      )
      continue
    }

    const routeName = definition.name
    const toolName = agent.toolName ?? routeName

    // Two routes claiming one tool name is a genuine conflict, not a merge:
    // the manifest is keyed by name, and an adapter registering the second
    // would either throw or shadow the first. First registration wins so the
    // result is deterministic wherever the definitions came from, and the
    // loser is named rather than dropped in silence.
    //
    // Settled *before* the schemas are walked, not after: the loser's walker
    // warnings would be computed and then thrown away, so resolving the
    // collision would surface warnings that read as newly introduced.
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
    const tool: DerivedAgentTool = {
      toolName,
      routeName,
      method,
      path: definition.path,
      description: agent.description ?? definition.description ?? definition.summary,
      inputSchema: buildInputSchema(definition, method, toolWarnings),
      outputSchema: buildOutputSchema(definition, method, toolWarnings),
      // Declared, not derived — see the field's own doc for why an
      // unrepresentable `output` must still suppress the hint.
      resource: definition.schemas?.output ? undefined : definition.resource,
      annotations: {
        readOnlyHint,
        // The MCP spec's default for a non-read-only tool is `true`; declaring
        // `false` is the strong claim "additive updates only", which
        // `guren check` verifies against the controller body. Resolved to an
        // explicit value here so nothing downstream has to know the default.
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
 * of a tool input and what an agent finds ergonomic — the namespaced
 * `{ params, query, body }` alternative is recorded in the RFC as rejected.
 *
 * The merge is ordered params → path supplements → query → body, and a later
 * source wins a collision. Deliberately a warning and not a throw: the runtime
 * derivation stays total, and the corresponding `guren check` rule fails the
 * build instead, where a rename is actually possible.
 *
 * One thing no schema can override: a path parameter is required, because the
 * URL cannot be built without it. That is applied after the merge, so it holds
 * however the parameter came to be described.
 */
function buildInputSchema(
  definition: RouteDefinition,
  method: string,
  warnings: string[],
): AgentToolSchema {
  const label = `${method} ${definition.path}`
  // Null-prototype: a path parameter may legally be named `__proto__`
  // (`/posts/:__proto__` — the lexer accepts `[A-Za-z0-9_-]+`), and assigning
  // that key on a plain `{}` invokes the prototype setter instead of defining
  // a property, so the argument would vanish from the advertised schema. The
  // same reasoning `Router.serializeResourceHint` records for its envelope
  // keys.
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
  // the caller has to supply — the same supplementation `@guren/openapi`'s
  // buildParameters applies, off the same lexer (`../internal/route-path`), so
  // the two surfaces cannot disagree about what a path declares. They did:
  // `/files/:name*` is one parameter named `name*`, which is what Hono
  // registers and what a tool must ask for; the OpenAPI document renders it as
  // `{name}` on purpose (RFC 6570 reads `{name*}` as "explode"), and that
  // stays a rendering decision at its own call site rather than a second lexer.
  //
  // Known limitation, shared with the OpenAPI document on purpose: Hono's
  // optional modifier (`/posts/:id?`) is lexed away with the rest of the
  // token, so an optional path parameter is advertised as required. Relaxing
  // it here alone would re-split the two surfaces; it belongs in the shared
  // lexer, for both.
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

  const body = definition.schemas?.body
    ? toJsonSchema(definition.schemas.body, warnings, `${label} body`, 'input')
    : undefined
  if (body) {
    // An object body's properties merge in flat. Anything else — an array, a
    // primitive, a union, a record, a transform — nests under `body`, because
    // a tool input has to have an object root. `properties` rather than
    // `type === 'object'` is the test: a `z.record()` renders as an object
    // with `additionalProperties` and no properties, and flattening it would
    // contribute nothing while dropping what it does say.
    if (body.type === 'object' && body.properties) {
      mergeProperties(merged, body.properties, new Set(body.required ?? []), 'body', warnings)
    } else {
      // Required: the route binds a body schema, so the endpoint validates one.
      // (A schema that permits omission looks identical here — the walker sees
      // through `.optional()` — and claiming it optional would advertise a call
      // the route rejects.)
      mergeProperties(merged, { body }, new Set(['body']), 'body', warnings)
    }
  }

  // Structural, so it is applied last and outranks every schema that had an
  // opinion: a path parameter is part of the URL, and a request cannot be
  // built without it. A `params` schema declaring `id` optional, or a body key
  // colliding with one and declaring itself optional, describes the *type* of
  // that argument — not whether the caller may omit it. (`@guren/openapi`
  // states the same rule as `required: true` on every path parameter.)
  for (const name of pathParamNames) {
    if (name in merged.properties) merged.required.add(name)
  }

  const required = Array.from(merged.required)
  return {
    type: 'object',
    // Copied onto a normal object: `merged.properties` has a null prototype
    // (see above), which JSON.stringify handles but a consumer calling
    // `hasOwnProperty` on the returned schema would not.
    properties: { ...merged.properties },
    ...(required.length > 0 ? { required } : {}),
  }
}

/**
 * Fold one source's properties into the merge. A collision replaces both the
 * property *and* its required-ness — carrying a losing source's `required`
 * forward would demand a key the advertised schema no longer describes.
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
 * The route's `output` schema, which is the only response shape validated at
 * runtime — so advertising it costs no new machinery. A `resource` hint is the
 * next rung of RFC 0016's ladder and is CLI-only: `definitions()` carries
 * class names, and the type text behind them exists solely in the CLI's AST
 * extraction.
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
 *
 * Everything else is omitted rather than guessed — `'any'`/`'mixed'`, several
 * abilities, an `abilityFor` callback that overrides the verb map, a custom
 * verb the map refuses, or a definition from a server old enough to carry no
 * capabilities at all. Absence means "undetermined", which is what lets
 * `guren check`'s "authn is not authz" rule fail closed on it instead of
 * reading a name that was never checked.
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
    // it — restating the table here is how a tool comes to advertise an
    // ability the middleware stopped checking.
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

/**
 * `appTools()` (RFC 0029 §2): the application's derived agent tools as model
 * tools, every call through `createAgentInvocationPipeline` under the
 * `'in-process'` surface. Scope, approval, redaction and audit are the
 * pipeline's; this module only decides which tools an agent may be handed.
 */
import {
  PORTABLE_AGENT_TOOL_NAME_PATTERN,
  createAgentApprovalContext,
  createAgentCallBudget,
  createAgentInvocationPipeline,
  expandToolScopes,
  parseToolScope,
  type AgentInvocationDenial,
  type AgentInvocationPipeline,
  type AgentToolSchema,
  type Application,
  type DerivedAgentTool,
  type DerivedAgentToolAnnotations,
  type ScopedTool,
  type ToolCallOutcome,
} from '@guren/core'
import { jsonSchema, tool, type JSONSchema7, type Tool } from 'ai'

import { resolveAgentName } from './agent'
import { describeNames } from './config'
import { readAgentContext, type AgentContext } from './context'
import { resolveRuntime, type AiRuntime } from './runtime'

/** A runtime-neutral tool: what an adapter for another agent runtime wraps. */
export interface AppToolDefinition {
  name: string
  description?: string
  /** JSON Schema, object root. */
  inputSchema: AgentToolSchema
  annotations: DerivedAgentToolAnnotations
  /** One call through the invocation pipeline. Throws only when the dispatch itself broke. */
  execute(args: Record<string, unknown>): Promise<unknown>
}

/** What the model reads when a gate refused the call. Nothing was executed. */
export interface AppToolDenial {
  denied: AgentInvocationDenial['reason']
  message: string
  /** The approval gate's body (`status`, `requestId`, `expiresAt`, ...), when it refused. */
  approval?: Record<string, unknown>
}

/** What the model reads when the route answered with an error status. */
export interface AppToolError {
  error: true
  status: number
  body: unknown
}

const CALLS_PER_MINUTE = 60

const warnedNonPortable = new Set<string>()

export function appToolDefinitions(agent: object, names: readonly string[]): AppToolDefinition[] {
  const context = readAgentContext(agent)
  const runtime = resolveRuntime(context.container, `${resolveAgentName(context.cls)} calls appTools(), which`)
  const derived = runtime.tools()
  const scoped = derived.map(toScopedTool)
  const granted = expandToolScopes(context.cls.scopes, scoped)
  const selected = selectTools(context, derived, new Set(granted), [...new Set(names)])
  const pipeline = (context.pipeline ??= buildPipeline(context, runtime, effectiveAbilities(context, scoped, granted)))

  return selected.map((derivedTool) => ({
    name: derivedTool.toolName,
    ...(derivedTool.description !== undefined ? { description: derivedTool.description } : {}),
    inputSchema: derivedTool.inputSchema,
    annotations: derivedTool.annotations,
    execute: async (args) => toToolResult(derivedTool, await pipeline.invoke({ tool: derivedTool, args })),
  }))
}

export function appTools(agent: object, names: readonly string[]): Record<string, Tool> {
  return Object.fromEntries(
    appToolDefinitions(agent, names).map((definition) => {
      warnIfNonPortable(definition.name)
      return [
        definition.name,
        tool({
          description: definition.description,
          inputSchema: jsonSchema(definition.inputSchema as JSONSchema7),
          execute: (args: unknown) => definition.execute(args as Record<string, unknown>),
        }),
      ]
    }),
  )
}


/**
 * Every problem at once, as one construction error (RFC 0029 §2.2): a name no
 * route derives, a name the class's scopes do not grant, a write under `as(null)`.
 */
function selectTools(
  context: AgentContext,
  derived: readonly DerivedAgentTool[],
  granted: ReadonlySet<string>,
  names: readonly string[],
): DerivedAgentTool[] {
  const agentName = resolveAgentName(context.cls)
  const scopes = context.cls.scopes
  const problems: string[] = []

  for (const entry of scopes) {
    if (!parseToolScope(entry)) {
      problems.push(
        `static scopes entry "${entry}" is not in the scope grammar (tool:<name>, tools:<prefix>.*, `
        + 'tools:read, tools:*), so it grants nothing.',
      )
    }
  }

  const selected: DerivedAgentTool[] = []
  for (const name of names) {
    const found = derived.find((candidate) => candidate.toolName === name)
    if (!found) {
      problems.push(
        `no route derives the tool "${name}". Tools this application exposes: `
        + `${describeNames(derived.map((candidate) => candidate.toolName))}.`,
      )
      continue
    }
    if (!granted.has(name)) {
      problems.push(
        `the tool "${name}" is not granted by static scopes (${describeNames(scopes)}). `
        + `Add 'tool:${name}' to ${agentName}.scopes.`,
      )
      continue
    }
    if (context.principal === null && !found.annotations.readOnlyHint) {
      problems.push(
        `the tool "${name}" is not declared read-only, and this run is as(null). An anonymous run `
        + 'carries no identity for a write to be authorized or approved against; bind one with as(user).',
      )
      continue
    }
    selected.push(found)
  }

  if (problems.length > 0) {
    throw new Error(`${agentName}.appTools() cannot be built:\n${problems.map((line) => `  - ${line}`).join('\n')}`)
  }
  return selected
}

function buildPipeline(
  context: AgentContext,
  runtime: AiRuntime,
  abilities: string[],
): AgentInvocationPipeline {
  const { container, principal } = context
  const app = container.make<Application>('app')
  const approvals = createAgentApprovalContext(runtime.approvals, principal)
  // Per bound instance: a floor on one run's burst rate, bounding a model that
  // loops on a failing tool. Same meter as `@guren/plugin-agents`' (RFC 0017 §4).
  const budget = createAgentCallBudget({
    callsPerMinute: CALLS_PER_MINUTE,
    message: (limit) =>
      `This agent has already made ${limit} tool calls in the last minute, which is its budget. `
      + 'Nothing was executed.',
  })

  return createAgentInvocationPipeline({
    // `boot()` is idempotent; after a failed boot it retries rather than
    // dispatching into a half-assembled app, as `agentsPlugin` does.
    app: {
      fetch: async (request, env, executionCtx) => {
        await app.boot()
        return app.fetch(request, env, executionCtx)
      },
    },
    principal,
    abilities,
    surface: 'in-process',
    audit: runtime.audit(),
    ...(approvals ? { approvals } : {}),
    approvalConfigureHint: 'aiPlugin({ approvals: { store, notify } })',
    scopeSubject: "The agent's scopes",
    interpose: budget,
    origin: applicationOrigin(context),
    handoff: 'seam',
  })
}

/**
 * The class's scopes, narrowed by the principal's own abilities when it carries
 * any: intersected as *tools*, never as strings, since `tools:posts.*` and
 * `tool:posts.show` share a tool and no string. Consent narrows; it never widens.
 */
function effectiveAbilities(context: AgentContext, scoped: readonly ScopedTool[], granted: readonly string[]): string[] {
  const abilities = context.principal?.abilities
  const consented = abilities ? new Set(expandToolScopes(abilities, scoped)) : undefined
  return granted.filter((name) => !consented || consented.has(name)).map((name) => `tool:${name}`)
}

/**
 * The validated env's `APP_URL`, so host-authorization middleware sees the app's
 * real host. Without one, `http://localhost`, which such middleware must admit,
 * as it must for `guren tool:call` and durable agents.
 */
function applicationOrigin(context: AgentContext): string {
  const env = context.container.makeOptional('env') as Readonly<Record<string, unknown>> | undefined
  const url = env?.APP_URL
  if (typeof url === 'string' && URL.canParse(url)) return new URL(url).origin
  return 'http://localhost'
}

function toScopedTool(derivedTool: DerivedAgentTool): ScopedTool {
  return { name: derivedTool.toolName, readOnly: derivedTool.annotations.readOnlyHint }
}

function toToolResult(
  derivedTool: DerivedAgentTool,
  result: Awaited<ReturnType<AgentInvocationPipeline['invoke']>>,
): unknown {
  if (result.status === 'failed') {
    // Thrown into the tool: the AI SDK reports it to the model as a tool error.
    throw new Error(`The tool "${derivedTool.toolName}" could not be dispatched: ${result.message}`)
  }
  if (result.status === 'denied') {
    const { reason, message, body } = result.denial
    return { denied: reason, message, ...(body ? { approval: body } : {}) } satisfies AppToolDenial
  }
  const body = outcomeBody(result.outcome)
  return result.outcome.isError
    ? ({ error: true, status: result.outcome.status, body } satisfies AppToolError)
    : body
}

function outcomeBody(outcome: ToolCallOutcome): unknown {
  if (outcome.structuredContent) return outcome.structuredContent
  const text = outcome.content.map((part) => part.text).join('\n')
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/**
 * Anthropic and OpenAI reject a tool name outside `[A-Za-z0-9_-]{1,64}`, so a
 * dotted route name works against a mock and fails against those providers.
 * Warned, not refused: other providers accept it. `agent.toolName` is the fix.
 */
function warnIfNonPortable(name: string): void {
  if (PORTABLE_AGENT_TOOL_NAME_PATTERN.test(name) || warnedNonPortable.has(name)) return
  warnedNonPortable.add(name)
  console.warn(
    `[@guren/plugin-ai] The tool name "${name}" is outside [A-Za-z0-9_-]{1,64}, which some model providers `
    + '(Anthropic, OpenAI) reject. Set agent.toolName on its route to a portable name.',
  )
}

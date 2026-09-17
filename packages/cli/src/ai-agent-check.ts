/**
 * In-process agent checks (RFC 0029 §8). A name `appTools()` is handed that no
 * route derives, or that `static scopes` does not grant, and a scope outside
 * the grammar are construction errors at `as()`; a missing `aiPlugin()` makes
 * the first `appTools()` throw; an audit trail configured in both `aiPlugin()` and
 * `mcpPlugin()` throws at the first tool call (§2.5). Content-activated: an app
 * with no `Agent` subclass contributes nothing, and nothing loads for it.
 */
import { deriveAgentTools, expandToolScopes, parseToolScope, type RouteDefinition } from '@guren/core'
import {
  AI_PLUGIN_EXPORT,
  effectiveAppToolsCalls,
  effectiveScopes,
  scanAiAgents,
  type ScannedAgent,
} from './ai-agent-scan'
import { check, type CheckResult } from './check-result'
import type { ParseCache } from './parse-cache'
import { MCP_PLUGIN_EXPORT, scanPluginCalls } from './plugin-calls'

const TITLE = 'In-process agents'
/** The option both plugins read their trail from; neither package is importable here. */
const AUDIT_CONFIG_KEY = 'audit'

export interface AiAgentCheckOptions {
  cwd: string
  cache: ParseCache
  /** Loaded route definitions; `undefined` when the route graph could not be loaded. */
  definitions?: RouteDefinition[]
}

export async function checkAiAgents(options: AiAgentCheckOptions): Promise<CheckResult[]> {
  const { cwd, cache, definitions } = options
  const agents = await scanAiAgents(cwd, cache)
  if (agents.length === 0) return []

  // First declaration wins, as the inheritance lookups have to pick one; a
  // second class under the same name is reported rather than resolved.
  const byName = new Map<string, ScannedAgent>()
  const results: CheckResult[] = []
  for (const agent of agents) {
    const taken = byName.get(agent.className)
    if (!taken) {
      byName.set(agent.className, agent)
      continue
    }
    results.push(
      check(
        `ai-agent-name-collision:${agent.className}`,
        TITLE,
        'warn',
        `${agent.className} is declared in both ${taken.relPath} and ${agent.relPath}. A subclass of either resolves its scopes and tools() from whichever was found first, so a verdict about one may describe the other.`,
        `Rename one of the two ${agent.className} classes.`,
        agent.relPath,
      ),
    )
  }
  const tools = definitions ? deriveAgentTools(definitions).tools : undefined

  for (const agent of agents) {
    const scopes = effectiveScopes(agent, byName)
    const calls = effectiveAppToolsCalls(agent, byName)
    const location = `${agent.relPath}:${agent.line}`

    if (agent.ownScopes === null) {
      results.push(
        check(
          `ai-agent-scopes-unreadable:${agent.className}`,
          TITLE,
          'warn',
          `${agent.className}.scopes is not an array of string literals, so its appTools() names were not checked against it (unverifiable, not passed).`,
          "Write static scopes as a literal array, e.g. ['tool:tickets_show'] as const.",
          location,
        ),
      )
    }

    for (const entry of agent.ownScopes ?? []) {
      if (parseToolScope(entry)) continue
      results.push(
        check(
          `ai-agent-scope-malformed:${agent.className}:${entry}`,
          TITLE,
          'fail',
          `${agent.className}.scopes entry '${entry}' is outside the scope grammar (tool:<name>, tools:<prefix>.*, tools:read, tools:*), so it grants nothing and as() throws.`,
          /^[A-Za-z0-9._-]+$/.test(entry) ? `Write 'tool:${entry}'.` : 'Rewrite the entry in the scope grammar.',
          location,
        ),
      )
    }

    const names = new Set<string>()
    for (const call of calls) {
      call.names.forEach((name) => names.add(name))
      if (!call.unreadable) continue
      results.push(
        check(
          `ai-agent-app-tools-unreadable:${agent.className}:${call.line}`,
          TITLE,
          'warn',
          `${agent.className} calls appTools() at line ${call.line}, but ${call.unreadable}, so its names were not checked (unverifiable, not passed).`,
          'Pass appTools() an array of string literals so the check and the generated types can read it.',
          agent.relPath,
        ),
      )
    }
    if (names.size === 0) continue

    if (!tools) {
      results.push(
        check(
          `ai-agent-tools-unverified:${agent.className}`,
          TITLE,
          'warn',
          `${agent.className} hands appTools() ${names.size} name(s), but the route graph did not load, so they were not checked against the derived tools.`,
          'Fix the route graph (see the route-graph result of `bunx guren check`), then run: bunx guren check',
          location,
        ),
      )
      continue
    }

    results.push(...judgeNames(agent, [...names], tools, scopes, location))
  }

  results.push(...(await pluginFindings(cwd, cache, agents, byName)))

  if (results.length > 0) return results
  return [
    check(
      'ai-agents',
      TITLE,
      'pass',
      `${agents.length} in-process agent(s) checked: every appTools() name is derived by a route and granted by its class's scopes, and aiPlugin() is registered.`,
    ),
  ]
}

function judgeNames(
  agent: ScannedAgent,
  names: string[],
  tools: ReturnType<typeof deriveAgentTools>['tools'],
  scopes: string[] | null,
  location: string,
): CheckResult[] {
  const results: CheckResult[] = []
  const scoped = tools.map((tool) => ({ name: tool.toolName, readOnly: tool.annotations.readOnlyHint }))
  const granted = scopes ? new Set(expandToolScopes(scopes, scoped)) : undefined
  const available = tools.map((tool) => tool.toolName).sort()

  for (const name of names) {
    if (!available.includes(name)) {
      results.push(
        check(
          `ai-agent-tool-underived:${agent.className}:${name}`,
          TITLE,
          'fail',
          `${agent.className} hands appTools() '${name}', but no .agent() route derives that tool, so as() throws.`,
          available.length > 0
            ? `Use one of: ${available.join(', ')}; or declare .agent() on the route named '${name}'.`
            : `This app exposes no agent tools: declare .agent() on the route named '${name}'.`,
          location,
        ),
      )
      continue
    }
    // Unreadable scopes were reported above; judging against a guess would invent a verdict.
    if (!granted || granted.has(name)) continue
    results.push(
      check(
        `ai-agent-tool-unscoped:${agent.className}:${name}`,
        TITLE,
        'fail',
        `${agent.className} hands appTools() '${name}', but its static scopes (${scopes!.length > 0 ? scopes!.join(', ') : 'none'}) do not grant it, so as() throws.`,
        `Add 'tool:${name}' to ${agent.className}.scopes.`,
        location,
      ),
    )
  }
  return results
}

async function pluginFindings(
  cwd: string,
  cache: ParseCache,
  agents: ScannedAgent[],
  byName: ReadonlyMap<string, ScannedAgent>,
): Promise<CheckResult[]> {
  // The app's own trees answer the duplicate rule, which accuses the running
  // app: a test helper or script configuring both plugins is not that app.
  const aiCalls = await scanPluginCalls(cwd, cache, AI_PLUGIN_EXPORT)
  const results: CheckResult[] = []

  // Absence is only evidence when nothing anywhere in the project calls it.
  if (aiCalls.length === 0 && (await scanPluginCalls(cwd, cache, AI_PLUGIN_EXPORT, 'project')).length === 0) {
    const needing = agents.filter((agent) => effectiveAppToolsCalls(agent, byName).length > 0)
    // A warn, like an unbound session config: the evidence is an absence.
    results.push(
      check(
        'ai-agent-plugin-missing',
        TITLE,
        'warn',
        needing.length > 0
          ? `${needing.map((agent) => agent.className).join(', ')} ${needing.length === 1 ? 'calls' : 'call'} appTools(), but nothing in the app calls aiPlugin(), so the first as() throws.`
          : `${agents.length} Agent subclass(es) exist, but nothing in the app calls aiPlugin(): appTools(), queue() and the audit trail all need it.`,
        "Add aiPlugin() from '@guren/plugin-ai' to createApp({ providers }), or run: bunx guren add ai",
      ),
    )
  }

  const aiAudit = aiCalls.find((call) => call.keys.has(AUDIT_CONFIG_KEY))
  if (aiAudit) {
    const mcpAudit = (await scanPluginCalls(cwd, cache, MCP_PLUGIN_EXPORT)).find((call) => call.keys.has(AUDIT_CONFIG_KEY))
    if (mcpAudit) {
      results.push(
        check(
          'ai-agent-audit-duplicate',
          TITLE,
          'fail',
          `The agent audit trail is configured twice: aiPlugin({ audit }) in ${aiAudit.relPath} and mcpPlugin({ audit }) in ${mcpAudit.relPath}. The first appTools() call throws.`,
          "Keep mcpPlugin's; aiPlugin() records into it when given no audit of its own.",
          aiAudit.relPath,
        ),
      )
    }
  }

  return results
}

/**
 * `@guren/plugin-agents` — durable agents as application citizens
 * (RFC 0017 Part 2a).
 *
 * This entry is Bun-safe and must stay that way: an app registers the plugin in
 * `src/app.ts`, which `guren dev` evaluates on Bun, while `agents` statically
 * imports `cloudflare:workers`. The subclass lives behind
 * `@guren/plugin-agents/agent`; nothing reachable from here imports `agents`.
 */
export { defineAgentsConfig, validateAgentsConfig, describeAgentsConfigProblems, DEFAULT_AGENT_CALLS_PER_MINUTE } from './config'
export type {
  AgentBudgetConfig,
  AgentRegistrationConfig,
  AgentRouteAuthorizer,
  AgentRouteTarget,
  AgentsApprovalsConfig,
  AgentsConfig,
  AgentsConfigProblem,
  AgentsRoutingConfig,
} from './config'

export { agentsPlugin } from './plugin'
export type { AgentsPluginConfig } from './plugin'

/**
 * The runtime seam — `configureAgentRuntime`, `resolveAgentRuntime`,
 * `createAgentToolClient` and their types — is **not** re-exported here. It
 * lives at `@guren/plugin-agents/runtime`, so that agent code reaching for it
 * is a boundary crossing `guren check --arch` can name. See that module's
 * header.
 */

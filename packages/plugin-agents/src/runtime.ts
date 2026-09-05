/**
 * `@guren/plugin-agents/runtime` — the seam between a booted application and
 * the Durable Objects that call its tools.
 *
 * Its own subpath, not the root: everything here hands out an application to
 * dispatch into or mints a principal to dispatch as, so an agent class could
 * build itself a client with scopes it was never granted. Off the root,
 * `make:agent`'s arch rule can name it in `disallowPackages` — a discipline,
 * not a sandbox, since in-process code shares this isolate (RFC 0017 §4).
 */
export {
  configureAgentRuntime,
  findRegistrationByName,
  freezeAgentRegistrations,
  resetAgentRuntime,
  resolveAgentRuntime,
} from './latch'
export type { AgentRegistration, AgentRuntime, AgentRuntimeResolver } from './latch'

export { createAgentToolClient } from './tool-client'
export type {
  AgentToolCallDenied,
  AgentToolCallFailed,
  AgentToolCallOk,
  AgentToolCallPending,
  AgentToolCallResult,
  AgentToolClient,
  AgentToolClientOptions,
} from './tool-client'

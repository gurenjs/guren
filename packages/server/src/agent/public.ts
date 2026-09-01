/**
 * The published entry of `@guren/server/agent` (mirrored as
 * `@guren/core/agent`): the half of the agent surface an *out-of-process*
 * dispatcher needs — a browser tab running WebMCP, a CLI, a test harness —
 * as opposed to the half that only makes sense inside a running application.
 *
 * Everything else under `src/agent/` stays internal and is reached through
 * the package index: the audit events, the approval queue, the scope grammar
 * and `deriveAgentTools` itself all import from the application (`Event`, the
 * container, `Router`), which is exactly what a client bundle must not pull
 * in. This module is the one place that promises otherwise, so the promise is
 * stated here rather than left to whoever next adds a re-export:
 *
 * - **Pure Web API.** `Request` / `Response` / `Headers` / `URLSearchParams`
 *   and nothing else. No `node:` import, no Bun global, no DOM access — the
 *   module must be importable under SSR as well as in a browser. Its two
 *   transitive imports (`../internal/route-path`, `../internal/agent-preflight`)
 *   are string and regex constants for that reason.
 * - **Types only from `./derive`.** `dispatch.ts` imports `DerivedAgentTool`
 *   with `import type`, so the derivation — which reaches `Router` and the
 *   authorization middleware — never enters the graph. Re-exporting a *value*
 *   from `./derive` here would undo that silently: the bundle would grow the
 *   whole route layer and nothing would fail.
 *
 * A consumer holding a `.guren/agents.gen.ts` manifest therefore has
 * everything needed to turn a flat tool call into the HTTP request the route
 * validates, and the route's response back into an MCP tool result — the one
 * dispatch contract (RFC 0016 §3), not a second one written per surface.
 */
export {
  advertisesStructuredOutput,
  buildToolRequest,
  mapToolResponse,
  PREFLIGHT_ARGUMENT,
} from './dispatch'
export type {
  BuildToolRequestOptions,
  BuiltToolRequest,
  ToolCallOutcome,
} from './dispatch'
export type {
  AgentToolInputSource,
  AgentToolSchema,
  DerivedAgentTool,
  DerivedAgentToolAnnotations,
  DerivedAgentToolExposure,
} from './derive'
export type { AgentSurface } from './events'

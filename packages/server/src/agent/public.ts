/**
 * The published entry of `@guren/server/agent` (mirrored as
 * `@guren/core/agent`): the half of the agent surface an *out-of-process*
 * dispatcher needs — a browser tab running WebMCP, a CLI, a test harness.
 *
 * Two rules keep it importable there. Pure Web API only (`Request`,
 * `Response`, `Headers`, `URLSearchParams`): no `node:` import, no Bun global,
 * no DOM, so it loads under SSR too. And types only from `./derive` —
 * re-exporting a *value* would silently pull `Router` and the authorization
 * middleware into a client bundle, with nothing failing.
 */
export {
  advertisesStructuredOutput,
  buildToolRequest,
  describeBuildFailure,
  mapToolResponse,
  PREFLIGHT_ARGUMENT,
} from './dispatch'
export type {
  BuildToolRequestOptions,
  BuiltToolRequest,
  ToolCallOutcome,
  ToolRequestBuildFailure,
} from './dispatch'
export type {
  AgentToolInputSource,
  AgentToolSchema,
  DerivedAgentTool,
  DerivedAgentToolAnnotations,
  DerivedAgentToolExposure,
} from './derive'
export type { AgentSurface } from './events'

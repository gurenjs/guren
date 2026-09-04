/**
 * The wire protocol of an agent preflight (RFC 0016 §5.4), in a leaf module so
 * `Router` (which answers one) and `agent/dispatch` (which asks) share it
 * without importing each other and closing a cycle. Not exported from the
 * package index: an external dispatcher goes through
 * `BuildToolRequestOptions.preflight`, and the header spelling stays internal.
 */

/** Request header asking the route for a verdict instead of an execution. */
export const AGENT_PREFLIGHT_HEADER = 'X-Guren-Agent-Preflight'

/**
 * Response header marking a body as a preflight verdict rather than the route's
 * own output. Read by the route's `output` schema validation (which would
 * otherwise reject the verdict as a 500) and by the MCP response mapping (which
 * would otherwise advertise it as the tool's `structuredContent`).
 */
export const AGENT_PREFLIGHT_VERDICT_HEADER = 'X-Guren-Agent-Preflight-Verdict'

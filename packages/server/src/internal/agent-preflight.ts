/**
 * The wire protocol of an agent preflight (RFC 0016 §5.4), in a leaf module
 * so the two halves can share it without depending on each other.
 *
 * `Router` mounts the seam that answers a preflight; `agent/dispatch` builds
 * the request that asks for one and reads the answer back. Putting the names
 * in either of those would make one import the other — today only
 * `dispatch → Router` exists, and the day `Router` needs anything from
 * `agent/` that becomes a cycle.
 *
 * Not exported from the package index: an external dispatcher asks for a
 * preflight through `BuildToolRequestOptions.preflight`, and the header
 * spelling is this seam's business, not published API.
 */

/** Request header asking the route for a verdict instead of an execution. */
export const AGENT_PREFLIGHT_HEADER = 'X-Guren-Agent-Preflight'

/**
 * Response header marking a body as a preflight verdict rather than the
 * route's own output.
 *
 * Load-bearing in two places that would otherwise mistake one for the other:
 * a route's `output` schema validation (which would reject the verdict and
 * turn it into a 500) and the MCP response mapping (which would advertise the
 * verdict as the tool's `structuredContent`, so an SDK client validates it
 * against the tool's output schema and throws). Both are answering the same
 * question — "is this the route's result?" — so both read the same marker.
 */
export const AGENT_PREFLIGHT_VERDICT_HEADER = 'X-Guren-Agent-Preflight-Verdict'

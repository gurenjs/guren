/**
 * The names a protocol adapter may add to an application's tool catalogue on
 * its own, and which an application route therefore may not claim (RFC 0016
 * §5.4).
 *
 * One rule, two readers: `@guren/plugin-mcp` adds `guren.preflight` to the
 * catalogue it serves, `guren check` fails a route whose tool name collides.
 * Restating either string is how they drift — and `tools/list` carrying two
 * tools with one name is rejected wholesale by an MCP client, so a collision
 * costs the *entire* catalogue. It lives beside the derivation because the CLI
 * cannot import the plugin. The `guren.` prefix is deliberately not reserved
 * wholesale: that would fail routes over collisions that do not exist.
 */

/**
 * The preflight companion tool (RFC 0016 §5.4). Preflight cannot be an
 * *argument* of the tool being checked: a tool advertising an `outputSchema`
 * must answer with conforming `structuredContent` unless the result is an
 * error, and a verdict conforms to no route's output. One meta-tool for the
 * whole catalogue, not one companion per tool (§5.5).
 */
export const PREFLIGHT_TOOL_NAME = 'guren.preflight'

/**
 * The approval-status companion tool (RFC 0016 §5.4 item 4). A caller handed a
 * request id needs something that can say what became of it, and the gated tool
 * cannot: a status is not that route's output. A second meta-tool rather than a
 * mode of the first, so neither output schema is the union of two unrelated
 * shapes.
 */
export const APPROVAL_STATUS_TOOL_NAME = 'guren.approval_status'

/** Every meta-tool name an adapter may occupy. */
export const RESERVED_AGENT_TOOL_NAMES: readonly string[] = [
  PREFLIGHT_TOOL_NAME,
  APPROVAL_STATUS_TOOL_NAME,
]

/**
 * Whether a tool name belongs to the framework rather than the application.
 * Case-sensitive: MCP tool names are matched literally, so `Guren.Preflight` is
 * a different tool and reserving it would take a name away for nothing.
 */
export function isReservedAgentToolName(name: string): boolean {
  return RESERVED_AGENT_TOOL_NAMES.includes(name)
}

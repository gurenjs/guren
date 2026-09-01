/**
 * The names a protocol adapter may add to an application's tool catalogue on
 * its own, and which an application route therefore may not claim (RFC 0016
 * §5.4).
 *
 * This is the one rule, with two readers. `@guren/plugin-mcp` adds
 * `guren.preflight` to the catalogue it serves; `guren check` fails a route
 * whose `.agent()` tool name would collide with it. Restating the string in
 * either place is how the two drift: the check would keep passing a route
 * whose tool the endpoint has already shadowed, and `tools/list` would carry
 * two tools with one name — which an MCP client rejects wholesale, so the
 * collision costs the *entire* catalogue, not the one tool.
 *
 * It lives beside the derivation rather than in the plugin because the check
 * cannot import the plugin (the CLI does not depend on it, and an app that
 * never installs App MCP is still checked), and the plugin must not restate a
 * name the check is enforcing.
 *
 * The list stays deliberately short. Every entry is a name taken away from
 * applications, and the `guren.` prefix is not reserved wholesale for the
 * same reason: reserving a namespace nothing occupies fails routes over a
 * collision that does not exist.
 */

/**
 * The preflight companion tool (RFC 0016 §5.4).
 *
 * Preflight cannot be an *argument* of the tool being checked on MCP: a tool
 * advertising an `outputSchema` must answer with `structuredContent`
 * conforming to it unless the result is an error, and a verdict conforms to
 * no route's output. So the verdict needs a tool of its own, with its own
 * output schema — one meta-tool for the whole catalogue, not one companion
 * per tool, which would double the catalogue against §5.5's own
 * catalogue-quality rule.
 */
export const PREFLIGHT_TOOL_NAME = 'guren.preflight'

/** Every meta-tool name an adapter may occupy. */
export const RESERVED_AGENT_TOOL_NAMES: readonly string[] = [PREFLIGHT_TOOL_NAME]

/**
 * Whether a tool name belongs to the framework rather than the application.
 *
 * Case-sensitive, like every other comparison the tool-name grammar makes:
 * MCP tool names are matched literally, so `Guren.Preflight` is a different
 * tool and reserving it would take a name away for nothing.
 */
export function isReservedAgentToolName(name: string): boolean {
  return RESERVED_AGENT_TOOL_NAMES.includes(name)
}

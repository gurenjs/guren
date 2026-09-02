/**
 * `@guren/plugin-mcp/oauth` — the seam a generated Cloudflare worker uses to
 * hand the App MCP endpoint a principal that some *other* authority already
 * verified (RFC 0016 §7).
 *
 * Its one caller today is the worker `guren cloudflare:build --mcp-oauth`
 * generates: `@cloudflare/workers-oauth-provider` validates its own access
 * token, delivers the grant's `props` as `ctx.props`, and the generated glue
 * maps them through {@link mcpOAuthPropsToAuth} and presents them with
 * {@link presentExternalMcpAuth} before delegating to the app.
 *
 * A subpath of its own rather than part of the main entry: an app that never
 * deploys behind an OAuth provider should not pull this into its module graph,
 * and the endpoint itself has no reason to publish a way of *writing* the
 * seam.
 *
 * See `./external-auth` for why the handoff is request identity and not a
 * header, and for the one-map invariant this re-export must not break.
 */
export {
  mcpOAuthPropsToAuth,
  presentExternalMcpAuth,
  type ExternalMcpAuth,
  type McpOAuthProps,
} from './external-auth'

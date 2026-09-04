/**
 * `@guren/plugin-mcp/oauth` — the seam a generated Cloudflare worker uses to
 * hand the App MCP endpoint a principal some *other* authority already verified
 * (RFC 0016 §7). A subpath of its own so an app that never deploys behind an
 * OAuth provider does not pull it into its module graph, and so the endpoint
 * publishes no way of *writing* the seam. See `./external-auth` for the one-map
 * invariant this re-export must not break.
 */
export {
  mcpOAuthPropsToAuth,
  presentExternalMcpAuth,
  type ExternalMcpAuth,
  type McpOAuthProps,
} from './external-auth'

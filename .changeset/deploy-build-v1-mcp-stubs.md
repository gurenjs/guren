---
'@guren/core': minor
'@guren/plugin-cloudflare': minor
'@guren/plugin-lambda': minor
'@guren/plugin-vercel': minor
---

Deploy builds stop stubbing the v1 MCP SDK, which no Guren package imports any more (RFC 0028 §4). `@guren/core/internal/deploy-build` drops the two SDK entries from `DEV_ONLY_MODULES`, `MCP_TRANSPORT_SPECIFIER`, `MCP_SDK_SUBPATH_PREFIX`, `stubbableDevOnlyModules` and `appUsesMcpPlugin`. Lambda and Vercel no longer route unlisted `@modelcontextprotocol/sdk/*` subpaths to a throwing stub. Cloudflare no longer fails a `@guren/plugin-mcp` app whose `wrangler.jsonc` aliases the v1 transport, and stops adding the two SDK aliases to a new config. It still writes `stub-mcp-server.js` and `stub-mcp-transport.js`, so an existing config keeps building; the two alias lines can be deleted. The stub error now reads "Dev MCP endpoint" on all three targets.

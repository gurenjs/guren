---
'@guren/core': minor
'@guren/plugin-cloudflare': minor
'@guren/plugin-lambda': minor
'@guren/plugin-vercel': minor
---

Deploy builds stop stubbing the v1 MCP SDK, which no Guren package imports any more (RFC 0028 §4). `@guren/core/internal/deploy-build` drops the two SDK entries from `DEV_ONLY_MODULES`, `MCP_TRANSPORT_SPECIFIER`, `MCP_SDK_SUBPATH_PREFIX`, `stubbableDevOnlyModules` and `appUsesMcpPlugin`. Lambda and Vercel no longer route unlisted `@modelcontextprotocol/sdk/*` subpaths to a throwing stub. Cloudflare no longer fails a `@guren/plugin-mcp` app whose `wrangler.jsonc` aliases the v1 transport, and stops adding the two SDK aliases to a new config. It also stops writing `stub-mcp-server.js` and `stub-mcp-transport.js`. An existing config that still aliases them keeps building, since nothing imports those subpaths; the two lines can be deleted. The `@guren/cli` stub's kind is renamed from `mcp` to `guren-cli`, and its error names both features the package backs: the Dev MCP endpoint and the docs viewer.

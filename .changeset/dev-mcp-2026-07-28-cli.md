---
'@guren/cli': minor
---

Add `createDevMcpHandler({ cwd })`, the Dev MCP server on MCP SDK v2 (RFC 0028). One fetch handler serves the 2026-07-28 protocol and 2025-era clients, with the same tools, resources and prompts as before. `@guren/server`'s `McpServiceProvider` mounts it when `GUREN_MCP=1`.

`@modelcontextprotocol/server` and `zod` are now runtime dependencies of `@guren/cli`. `bunx guren upgrade --check-only` reports imports of the deprecated `createMcpServer` from `@guren/server/mcp`.

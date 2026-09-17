---
'@guren/server': minor
---

Remove `createMcpServer` and its option types from `@guren/server/mcp`, deprecated in 2.24.0 (RFC 0028). The Dev MCP server lives in `@guren/cli` as `createDevMcpHandler`, and `McpServiceProvider` already mounts it. `@guren/server` no longer depends on `@modelcontextprotocol/sdk`. `guren upgrade --check-only` still reports a leftover import.

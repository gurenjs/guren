---
'@guren/server': minor
---

The Dev MCP endpoint (`GUREN_MCP=1`, `/_guren/mcp`) now serves the MCP 2026-07-28 protocol as well as 2025-era clients (RFC 0028). `McpServiceProvider` mounts the handler `createDevMcpHandler` from `@guren/cli` builds, behind the same loopback guard, and `@guren/server` no longer imports MCP SDK code on the path an app reaches.

**Behaviour changes on `/_guren/mcp`:** a `GET` or `DELETE` answers `405` (there is no session stream to open), and a `POST` whose `Content-Type` is not `application/json` answers `415`. When the installed `@guren/cli` predates `createDevMcpHandler`, or cannot be loaded, the endpoint is left unmounted with a warning instead of failing the boot.

**Deprecated:** `createMcpServer` from `@guren/server/mcp`, which serves only the 2025-era protocol. It warns once per process and is removed in the next minor; use `createDevMcpHandler({ cwd })` from `@guren/cli`. `bunx guren upgrade --check-only` reports imports of it. Both `@guren/server/mcp` exports are now marked `@experimental`.

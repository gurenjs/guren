---
"@guren/cli": patch
---

Append a compact Guren API signature digest to the `guren context` project map
so coding agents see the exact ORM, controller, and testing signatures at
session start — before their first edit attaches the glob-scoped rule files.
Delivered through the agent harness's SessionStart hook and the
`guren_get_context` MCP tool with no harness re-sync required.

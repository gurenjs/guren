---
"@guren/cli": patch
---

Append a compact Guren API signature digest to the `guren context` project map
so coding agents see the exact ORM, controller, and testing signatures at
session start — before their first edit attaches the glob-scoped rule files.
The digest rides on every markdown rendering of the map: the agent harness's
SessionStart hook and the markdown format of the `guren_get_context` MCP tool.
Installed apps pick it up with a CLI upgrade alone.

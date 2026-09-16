---
'@guren/server': minor
'@guren/core': minor
'@guren/cli': patch
---

`AgentSurface` gains `'in-process'`, the surface `@guren/plugin-ai` records a model's tool calls under (RFC 0029 §2.3). Audit trails read it back, and `guren tool:log --surface in-process` filters to it.

Code that maps every `AgentSurface` in a total `Record<AgentSurface, …>` or an exhaustive `switch` no longer compiles until it names the new member. That is the intended effect: a surface cannot be half-recorded. `@guren/core` re-exports the union, so it moves with server.

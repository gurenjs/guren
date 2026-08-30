---
'@guren/server': minor
'@guren/plugin-mcp': minor
---

Move the agent dispatch contract into `@guren/server` and add the preflight seam (RFC 0016 §3, §5.4).

`buildToolRequest` / `mapToolResponse` / `advertisesStructuredOutput` now ship from `@guren/core` rather than from the MCP plugin. Every surface that invokes a tool — the App MCP endpoint, `guren tool:call`, `@guren/testing` — has to build the same request and read the same response, and none of them can depend on an optional plugin; a second copy is how one of them comes to send a POST route's `query` keys in the body.

Preflight answers "would this be allowed" without the write happening. A tool call carrying `_preflight: true` runs the route's middleware and validates the contract the tool advertises, then stops before the handler and reports what it checked. The seam is mounted last, so every gate in front of it is the real one: an unauthenticated call is still the auth middleware's 401 and an unauthorized one its 403. Only routes declaring `.agent()` honour it, so no ordinary endpoint changes behaviour on a header any client can set. The `_preflight` key is stripped from the arguments before the request is built — forwarded, it would fail the very validation the caller asked to rehearse.

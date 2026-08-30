---
'@guren/server': minor
'@guren/plugin-mcp': minor
---

Move the agent dispatch contract into `@guren/server` and add the preflight seam (RFC 0016 §3, §5.4).

`buildToolRequest` / `mapToolResponse` / `advertisesStructuredOutput` now ship from `@guren/core` rather than from the MCP plugin. Every surface that invokes a tool — the App MCP endpoint, `guren tool:call`, `@guren/testing` — has to build the same request and read the same response, and none of them can depend on an optional plugin; a second copy is how one of them comes to send a POST route's `query` keys in the body.

Preflight answers "would this be allowed" without the write happening. A dispatch carrying `preflight: true` runs the route's middleware and validates the contract the tool advertises, then stops before the handler and reports what it checked — including what it could *not* check: a route that authorizes inside its action gets `unverified: ['authorization']`, because a seam that stops before the handler never reaches that call. The seam is mounted last, so every gate in front of it is the real one: an unauthenticated call is still the auth middleware's 401 and an unauthorized one its 403. Only routes declaring `.agent()` honour it, so no ordinary endpoint changes behaviour on a header any client can set. The `_preflight` key is stripped from the arguments before the request is built — forwarded, it would fail the very validation the caller asked to rehearse.

Preflight is not offered over MCP itself. The spec requires a tool advertising an `outputSchema` to answer with conforming `structuredContent` unless the result is an error, and a verdict conforms to no route's output — so the MCP form needs a companion tool, which is the same problem the approval queue has and belongs with it. `guren tool:call` and `@guren/testing` reach the seam through `BuildToolRequestOptions.preflight` instead.

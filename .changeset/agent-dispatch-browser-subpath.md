---
'@guren/server': minor
---

Add `@guren/server/agent`, the browser-safe half of the agent dispatch surface (RFC 0016 §3, §8).

`buildToolRequest`, `mapToolResponse` and `advertisesStructuredOutput` were reachable only through the package index, which pulls in the container, Hono, the ORM and the rest of the application graph — everything a client bundle must not carry. The new subpath re-exports exactly the names an *out-of-process* dispatcher needs, plus types only, and its two transitive imports (`internal/route-path`, `internal/agent-preflight`) are string and regex constants. Pure Web API throughout: nothing from `node:`, nothing Bun-specific, no DOM access at module scope, so it is importable under SSR as well as in a browser.

The entry deliberately re-exports **no value** from `agent/derive`. `dispatch.ts` imports `DerivedAgentTool` with `import type`, which is what keeps the derivation — and through it `Router` and the authorization middleware — out of the graph; a value re-export would undo that with nothing failing.

`BuildToolRequestOptions` gains `surface`, which sets the `X-Guren-Agent-Surface` header the builder previously hardcoded to `'mcp'`. It defaults to `'mcp'`, so every existing caller sends exactly what it sent before, and `'webmcp'` is what an in-browser call announces. The header is informational and write-only inside the framework — it is there for an application that wants to tell the surfaces apart, and no check may ever rest on it, since any client sets any header it likes.

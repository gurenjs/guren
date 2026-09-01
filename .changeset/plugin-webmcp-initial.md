---
'@guren/plugin-webmcp': minor
---

Add `@guren/plugin-webmcp`, the WebMCP client (RFC 0016 §7, Phase 3) — **experimental**.

`registerAgentTools(agentTools)` registers the tools an app's generated manifest marks `expose.webMcp` onto the browser's `modelContext` API, so an in-page agent calls them as the signed-in user: same session cookie, same CSRF token, same policies, same validation. The client entry (`@guren/plugin-webmcp/client`) imports from `@guren/core/agent` and nothing else, so a page bundle gets the dispatch contract without the application graph.

Deliberate behaviours:

- **A browser without the API is not an error.** No anchor means `{ supported: false }`, never a throw — this runs on every page load, and the API is pre-release. The anchor is looked for on `document` first, then the deprecated `navigator.modelContext`.
- **A registration failure is an error.** A duplicate tool name or a schema the host rejects is a wiring mistake the developer has to see; a page silently exposing nine tools of ten would look like it worked. The tools already registered are unregistered first, so a caller that catches is not left with half a catalogue.
- **`approval: 'required'` tools are skipped by default.** The server-side approval queue is reached through the App MCP endpoint and WebMCP has no equivalent, so registering one would offer an agent a call the application asked a human to confirm. `includeApprovalRequired` is the explicit opt-in.
- **A network failure returns an error result rather than rejecting.** A thrown `execute` reaches the agent as a host-level failure whose message is flattened or dropped.
- The result is the MCP-shaped subset only: `content`, `structuredContent`, `isError`. The dispatch outcome's `status` and `preflightVerdict` exist for a server-side audit trail that a WebMCP host does not have.

The server half is deliberately near-empty. `webMcpPlugin({ originTrial })` serves a Chrome origin-trial token as an appended `Origin-Trial` header — the one part of WebMCP only the application can do — and registers nothing otherwise. It is mounted in `register`, not `boot`, because Hono only runs a global middleware against routes registered after it.

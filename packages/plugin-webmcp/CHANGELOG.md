# @guren/plugin-webmcp

## 0.1.0

### Minor Changes

- 0346aeb: Add `@guren/plugin-webmcp`, the WebMCP client (RFC 0016 §7, Phase 3) — **experimental**.

  `registerAgentTools(agentTools)` registers the tools an app's generated manifest marks `expose.webMcp` onto the browser's `modelContext` API, so an in-page agent calls them as the signed-in user: same session cookie, same CSRF token, same policies, same validation. The client entry (`@guren/plugin-webmcp/client`) imports from `@guren/core/agent` and nothing else, so a page bundle gets the dispatch contract without the application graph.

  **Adoption is one line covering every agent route.** `expose.webMcp` defaults to `true`, so `registerAgentTools(agentTools)` registers the whole `.agent()` catalog. That is the intent — the catalog is already opt-in per route — but it makes adopting this plugin a single decision about all of them at once. Review `guren tool:list` first and mark anything that should not be reachable from a browser tab with `.agent({ expose: { webMcp: false } })`.

  Deliberate behaviours:

  - **A browser without the API is not an error.** No anchor means `{ supported: false }`, never a throw — this runs on every page load, and the API is pre-release. The anchor is looked for on `document` first, then the deprecated `navigator.modelContext`.
  - **A registration failure is an error.** A duplicate tool name or a schema the host rejects is a wiring mistake the developer has to see; a page silently exposing nine tools of ten would look like it worked. The tools already registered are removed first, so a caller that catches is not left with half a catalogue.
  - **Requests are pinned to this origin and redirects are refused.** `mode: 'same-origin'`, `redirect: 'manual'`. A tool call carries the session cookie's authority and the `X-XSRF-TOKEN` header, and `fetch` strips only `Authorization` across a cross-origin redirect, so one open redirect in the app would replay both to another host. A redirecting route reports that the client did not follow it; App MCP names the `Location` because it dispatches in-process, and a page cannot read an opaque redirect's target. Accepted parity gap.
  - **`approval: 'required'` tools are skipped by default.** The server-side approval queue is reached through the App MCP endpoint and WebMCP has no equivalent, so registering one would offer an agent a call the application asked a human to confirm. `includeApprovalRequired` is the explicit opt-in.
  - **A network failure returns an error result rather than rejecting.** A thrown `execute` reaches the agent as a host-level failure whose message is flattened or dropped.
  - The result is the MCP-shaped subset only: `content`, `structuredContent`, `isError`. The dispatch outcome's `status` and `preflightVerdict` exist for a server-side audit trail that a WebMCP host does not have.

  Tracking the draft: `registerTool(descriptor, { signal })` is how the current specification registers and — by aborting that signal — unregisters. `unregisterTool` is still called per name on teardown for earlier shipped hosts, since a host ignores a dictionary member it does not declare and the two generations are indistinguishable from the page. `ModelContextTool.description` is required and rejects an empty string, while a Guren route's description is optional, so a description-less tool registers as `METHOD /path` rather than throwing on page load.

  **Version ranges.** The client needs `@guren/core/agent`, new in core 1.13.0, and `gurenPlugin.compatibility` says exactly that (`">=1.13.0 <2.0.0"`). The `@guren/core` _dependency_ range stays at `^1.12.0` on purpose: Bun links a workspace dependency only through a range admitting the version on disk, so a forward floor falls through to npm — where that version does not exist yet — and `bun install --frozen-lockfile` cannot resolve the package at all. `changeset version` raises the floor for the published manifest (this workspace sets `updateInternalDependencies: "patch"`, so internal ranges are rewritten on any bump; measured against a disposable copy, `^1.12.0` became `^1.13.0` while `compatibility` was left untouched). Compatibility therefore leads the range for exactly one release, and nothing needs doing by hand at release time.

  Two deliberate asymmetries with App MCP, documented in the README and in the RFC's §7 amendment: a WebMCP call reaches **no audit sink** (it is an ordinary browser fetch, and the surface header is client-controlled, so an audit keyed on it would be suppressible by the caller it records), and there is **no scope filtering** (a session has no scopes, so the in-page agent sees every `expose.webMcp` tool at the user's full authority; policies still gate execution).

  The server half is deliberately near-empty. `webMcpPlugin({ originTrial })` serves a Chrome origin-trial token as an appended `Origin-Trial` header — the one part of WebMCP only the application can do — and registers nothing otherwise. It is mounted in `register`, not `boot`, because Hono only runs a global middleware against routes registered after it.

### Patch Changes

- Updated dependencies [0346aeb]
- Updated dependencies [0a5dd3c]
- Updated dependencies [39db410]
- Updated dependencies [bf4020f]
- Updated dependencies [691f12a]
- Updated dependencies [a6e3a1f]
  - @guren/core@1.13.0

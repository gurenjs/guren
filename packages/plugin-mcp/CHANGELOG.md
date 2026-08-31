# @guren/plugin-mcp

## 0.2.0

### Minor Changes

- 8f43757: Move the agent dispatch contract into `@guren/server` and add the preflight seam (RFC 0016 §3, §5.4).

  `buildToolRequest` / `mapToolResponse` / `advertisesStructuredOutput` now ship from `@guren/core` rather than from the MCP plugin. Every surface that invokes a tool — the App MCP endpoint, `guren tool:call`, `@guren/testing` — has to build the same request and read the same response, and none of them can depend on an optional plugin; a second copy is how one of them comes to send a POST route's `query` keys in the body.

  Preflight answers "would this be allowed" without the write happening. A dispatch carrying `preflight: true` runs the route's middleware and validates the contract the tool advertises, then stops before the handler and reports what it checked — including what it could _not_ check: a route that authorizes inside its action gets `unverified: ['authorization']`, because a seam that stops before the handler never reaches that call. The seam is mounted last, so every gate in front of it is the real one: an unauthenticated call is still the auth middleware's 401 and an unauthorized one its 403. Only routes declaring `.agent()` honour it, so no ordinary endpoint changes behaviour on a header any client can set.

  Preflight is not offered over MCP itself. The spec requires a tool advertising an `outputSchema` to answer with conforming `structuredContent` unless the result is an error, and a verdict conforms to no route's output — so the MCP form needs a companion tool, which is the same problem the approval queue has and belongs with it. `guren tool:call` and `@guren/testing` reach the seam through `BuildToolRequestOptions.preflight` instead.

- 15f969a: Add `@guren/plugin-mcp`: the production App MCP endpoint (RFC 0016 §7). `mcpPlugin()` mounts a bearer-authenticated Model Context Protocol endpoint (default `/mcp`) serving the tools the app's `.agent()` routes derive. Every call re-enters the application through `app.fetch` as a real HTTP request — validation, policies, and middleware run exactly once, in the app — with `env` and execution context forwarded for Workers bindings. The adapter enforces what must precede HTTP: bearer verification against the app's `ApiTokenStore`, token scopes (a token's catalog lists only what it can call; the `ApiToken` default `['*']` grants nothing), fail-closed refusal of `approval: 'required'` tools until the approval queue ships, and per-token rate limits with a stricter write budget. Each refusal emits `AgentToolDenied` and each execution `AgentToolInvoked`, arguments redacted.

  `@guren/server` grows the adapter-facing surface: `DerivedAgentTool.inputSources` and `inputBodyNested` record how a flat tool call maps back onto path, query, and body (the merge's inverse, so a POST route's `query` keys land where `validateQuery` reads them), `AuthManager.getApiTokenStore()` exposes the store `useTokens()` configured, and `readBearerToken` joins the root exports.

### Patch Changes

- Updated dependencies [327b4b5]
- Updated dependencies [1161036]
  - @guren/core@1.12.0

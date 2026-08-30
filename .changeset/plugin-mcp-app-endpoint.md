---
'@guren/plugin-mcp': minor
'@guren/server': minor
---

Add `@guren/plugin-mcp`: the production App MCP endpoint (RFC 0016 §7). `mcpPlugin()` mounts a bearer-authenticated Model Context Protocol endpoint (default `/mcp`) serving the tools the app's `.agent()` routes derive. Every call re-enters the application through `app.fetch` as a real HTTP request — validation, policies, and middleware run exactly once, in the app — with `env` and execution context forwarded for Workers bindings. The adapter enforces what must precede HTTP: bearer verification against the app's `ApiTokenStore`, token scopes (a token's catalog lists only what it can call; the `ApiToken` default `['*']` grants nothing), fail-closed refusal of `approval: 'required'` tools until the approval queue ships, and per-token rate limits with a stricter write budget. Each refusal emits `AgentToolDenied` and each execution `AgentToolInvoked`, arguments redacted.

`@guren/server` grows the adapter-facing surface: `DerivedAgentTool.inputSources` and `inputBodyNested` record how a flat tool call maps back onto path, query, and body (the merge's inverse, so a POST route's `query` keys land where `validateQuery` reads them), `AuthManager.getApiTokenStore()` exposes the store `useTokens()` configured, and `readBearerToken` joins the root exports.

---
'@guren/plugin-mcp': minor
---

Run the App MCP endpoint on the framework's invocation pipeline, and
authenticate external callers inside the application

The scope gate, the approval gate, the rate-limit meter, redaction and the audit
records move out of this package and onto `createAgentInvocationPipeline` in
`@guren/core`. Behaviour is unchanged: the same catalogue, the same refusal
text — including the fail-closed approval message, which still names
`mcpPlugin({ approvals: { store, notify } })` — the same audit records, and the
same ordering, with the per-token rate limit as the pipeline's interposition
hook so it still meters before the approval gate files a request and notifies
approvers.

One behaviour does change, and it closes a documented gap. On the external-auth
surface (`mcpPlugin({ auth: 'external' })`, the OAuth-fronted Workers
deployment built with `guren cloudflare:build --mcp-oauth`) the endpoint
forwards no `Authorization` header, because the inbound bearer belongs to the
authority in front of the application and the app's own guards cannot verify it.
Until now that left the dispatched request unauthenticated inside the
application, so a route behind `requireAuthenticated()` answered 401 to a
properly authorized caller. The endpoint now hands the principal over the
framework's in-process seam instead: `requireAuthenticated()`,
`Controller.auth` and `Gate` policies all see the OAuth caller.

`createBearerTokenMiddleware` and `tokenCan*` still refuse on that surface —
they judge an issued `ApiToken`, and there is none. The bearer surface is
untouched: a request presenting a token still forwards it, and the token guard
still verifies it, so `getApiToken(ctx)` and `tokenCan*` keep working there.

`gateToolCall` and the `GateVerdict` type are no longer exported from this
package — the scope gate moved into the framework with the rest of the agent
invocation pipeline, so import both from `@guren/core` instead. They are the
same function and the same type, so the migration is an import-path change.
`createAppMcpServer` now takes a `pipeline` instead of a `dispatch` function.

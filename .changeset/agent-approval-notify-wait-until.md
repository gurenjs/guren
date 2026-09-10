---
"@guren/server": minor
"@guren/plugin-mcp": minor
"@guren/core": minor
---

Keep an approval notification alive past the response on Workers

`notifyApprovers` issued the application's `notify` fire-and-forget, which
reads as "a dead channel must not fail the call it announces" everywhere the
process outlives the request. On workerd it means something else: a promise the
request context does not know about is abandoned when that context closes. An
app whose `notify` posts to Slack or sends mail had the approval record
persisted and nobody paged — and the warning that says exactly that ("the
request is recorded and pending, but nobody was told") lives inside the
abandoned `.catch`, so it never printed either. A human waited on an approval
nobody was told about, and nothing anywhere said so.

`notifyApprovers` and `createAgentApprovalContext` now take an optional
`defer`, and the App MCP endpoint supplies the request's
`ExecutionContext.waitUntil` — the same one it already hands the audit emitter.

How a best-effort side channel is invoked now lives in one place both use,
`keepAlive`: a synchronous throw and a rejection both reach the channel's own
warner, the `.catch` is attached *before* deferring (`waitUntil` on a rejecting
promise raises an unhandled rejection in workerd), and `defer` itself throws
there once the response has settled. Each of those is wrong in a way tests off
Workers cannot see, which is why they are one function rather than a comment
repeated at every site. Off Workers there is no execution context and the
behaviour is what it was.

The durable-agents surface (`@guren/plugin-agents`) is unchanged: it builds its
approval context with no execution context to pass. Whether a Durable Object
drops an undeferred promise the way a fetch handler does is an open question,
not one this change judged.

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
The rule that decides what deferral means now lives
in one place shared by both: `defer` itself throws in workerd once the response
has settled, and a second copy of that guard is how one of the two comes to
fail the call it was only recording. Off Workers there is no execution context
and the behaviour is what it was.

The durable-agents surface (`@guren/plugin-agents`) is unchanged: it builds its
approval context with no execution context to pass. Whether a Durable Object
drops an undeferred promise the way a fetch handler does is an open question,
not one this change judged.

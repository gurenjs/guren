---
"@guren/server": minor
"@guren/plugin-mcp": minor
"@guren/core": minor
---

Keep an agent audit write alive past the response on Workers

The audit emitter issued its sink fire-and-forget, which reads as "do not fail
the call this records" everywhere the process outlives the request. On workerd
it means something else: a promise the request context does not know about is
abandoned when that context closes. An app whose sink writes to D1 — the only
durable option there — had a best-effort trail, and the missing rows looked
exactly like tool calls that never happened, because nothing throws and nothing
warns.

`createAuditEmitter` now takes an optional `defer`, and the App MCP endpoint
supplies the request's `ExecutionContext.waitUntil`, so a slow sink still lands.
`AgentAuditEmitter` is unchanged — it is a public binding applications
implement — and the container binding stays the boot-time emitter that a surface
holding no request (`guren tool:call`) resolves. The event listeners are
deferred on the same terms. Off Workers there is no execution context and the
behaviour is what it was.

The durable-agents surface (`@guren/plugin-agents`) is unchanged: it resolves
that same boot-time emitter and its pipeline carries no execution context.
Whether a Durable Object drops an undeferred promise the way a fetch handler
does is an open question, not one this change judged.

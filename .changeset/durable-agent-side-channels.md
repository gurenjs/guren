---
"@guren/plugin-agents": patch
---

Record why durable agents hand no side channel to `waitUntil`

The App MCP endpoint hands its audit sink and approval notification to
`ExecutionContext.waitUntil`, because workerd abandons a promise that a fetch
handler's request context does not know about. The changes that added this left
the durable surface alone and named the reason an open question: whether a
Durable Object drops such a promise too.

It does not. Under Miniflare, an undeferred write started from a Durable
Object's `fetch`, an RPC method, `alarm`, or `webSocketMessage` landed every
time, including one still pending 30 seconds after the handler returned, while
the same write from a plain fetch handler in the same run was lost. The tool
client keeps building both channels with no deferrer and now says why beside
the code. Nothing changes at runtime.

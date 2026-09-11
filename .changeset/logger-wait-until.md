---
"@guren/server": patch
---

Keep an async log channel's write alive past the response on Workers

`Logger` issued an async channel's write fire-and-forget. On workerd, a promise
the request context does not know about is abandoned when a fetch handler's
context closes. A custom channel that posts to a log service therefore lost
every entry still in flight when the response was sent, silently.

`Application.fetch` now enters a request scope holding the request's
`ExecutionContext.waitUntil`, and `Logger` hands each async channel's pending
write to the same `keepAlive` the agent audit trail and the approval
notification use, which falls back to that scope when its caller passes no
`defer`. The scope is an `AsyncLocalStorage`, so the logger stays the container
singleton it was: a `log()` from a service that was never handed the request is
covered, which a per-request child logger could not do. An audit sink or
approval notification invoked with no `defer` during a Workers request is
kept alive the same way.

The scope is entered only when `app.fetch` receives a context with a callable
`waitUntil`, so off Workers nothing changes. A sync channel hands nothing to
`waitUntil`. A log call made outside a request, during boot for example, is
written undeferred as before. Only a fetch handler drops such work (a Durable
Object keeps it), which is why `Application.fetch` is the one place that enters
the scope.

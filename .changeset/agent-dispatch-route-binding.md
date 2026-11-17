---
'@guren/server': patch
---

An agent tool call now runs only on the route its tool was derived from. When a path argument makes the request match another route first (`{ id: 'new' }` on `/posts/:id` reaching an earlier `/posts/new`), the call is refused with a 400 before any of that route runs, so a path value can no longer carry a scope-gated or approval-gated call to a route those gates never judged. This covers a route a `createApp({ boot })` callback adds straight to Hono with `hono.get()` and the like, which matches ahead of every router route; a `hono.all()` route is not told apart from `hono.use()` middleware and is not covered. A route whose method, path and name another route also has is no longer exposed as a tool, with a warning, since a call could not tell the two apart.

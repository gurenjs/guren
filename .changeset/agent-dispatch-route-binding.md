---
'@guren/server': patch
---

An agent tool call now runs only on the route its tool was derived from. When a path argument makes the request match another route first (`{ id: 'new' }` on `/posts/:id` reaching an earlier `/posts/new`), that route refuses it with a 400 before any of its middleware runs, so a path value can no longer carry a scope-gated or approval-gated call to a route those gates never judged.

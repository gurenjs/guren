---
'@guren/cli': patch
---

`guren check` warns when a controller passes `defer()` in `this.inertia()` for a prop the page's `Props` declares as required (no `?`, no `| undefined`): the controller may pass a deferred value for any prop, so the call typechecks while the initial visit hands the component `undefined`. The props literal is read by AST; a spread, a non-literal props argument in an action that calls `defer()`, and a `Props` the reader cannot close are reported unverifiable rather than passed. Advisory, so `check --ci` and `gate` never fail on it.

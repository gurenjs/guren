---
'@guren/server': minor
'@guren/core': minor
---

A route contract's `body` schema is now validated on controller-action routes too, before the action runs, instead of only typing them. A body that fails it answers 422 through `ValidationException`, keyed by the full field path as `Controller.validateBody()` keys it, so Inertia forms display it unchanged. `Controller.validated()` returns the `params`, `query` and `body` the contract parsed (coercions, defaults and transforms applied; an undeclared segment is `undefined`), and `validated('posts.store')` is typed from the `GurenRouteContracts` registry that `guren codegen` writes. Passing a name other than the route being served throws, so an action mounted on several routes passes every name: `validated(['posts.update', 'posts.patch'])`.

Existing actions keep working: `validateBody()`, `input()` and the other body readers reuse the payload the contract already parsed. One ordering changes: a check an action makes itself, such as `this.auth.userOrFail()`, now runs only after the body passes, so an unauthenticated request with an invalid body gets 422 rather than 401. Move that check into route middleware where the 401 must come first. `RouteDefinition` gains `validatesBody: true` on routes whose body schema is enforced.

---
"@guren/cli": minor
"create-guren-app": patch
---

The generated API client derives params from path literals, types `json()` from bound output schemas, and closes a union-route-name type hole.

Route params are no longer stored on the generated `ApiRoutes` entries as a `params` field. Both `ApiRequestOptions` and `request()` now derive them from each entry's `path` literal — the same string the server routes on — through one shared emitted fragment (`PathParamKeys`, `HasPathParams`, `PathParamsOf`) that the route manifest module's `RouteParams`/`RouteArgs` are also expressed with, so a future change to the entry shape can never silently flip `request()`'s call arity and the rule has a single spelling across the generated modules. `ApiRouteParams<T>` remains exported with the same meaning, and `@guren/inertia-client`'s hand-mirrored copy of the rule is now pinned to the fragment's exact text by a test.

`request()` now returns `Promise<TypedResponse<...>>`: on routes that bind an `output` schema, `json()` resolves to that schema's parsed shape instead of `any`; without one it resolves to `unknown`, so asserting the shape at the call site stays explicit.

The path predicate is deliberately not distributed over a union route name. Previously `'posts.index' | 'posts.show'` accepted `params: {}` and could send a path with `:id` unresolved; now a union name requires every member's params (substituting a param a member's path lacks is a runtime no-op), which forces the safe call in both directions.

---
'@guren/server': minor
---

`Router.registeredBindingLookups()` says how each route's bound parameters are looked up: a model by its lookup column (`[Model, 'slug']`), or a router-level custom resolver as registered, with the router-level lookup beside a route-level one for a parameter bound at both levels, since both run. A route served by an inline or prototype handler looks nothing up, as it resolves no binding. `router.bind(param, [Model, 'slug'])` now keeps its column for it. Introspection reads it so `guren change:records` can tell a change of lookup column apart.

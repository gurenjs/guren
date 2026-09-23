---
'@guren/server': minor
---

`Application.introspect()` registers every provider and every route without mounting, booting or listening, and returns an `AppManifest` (RFC 0026): providers with how each registered, modules, routes with resolved middleware, JSON Schema contracts and module provenance, middleware aliases, container bindings, agent tools and warnings. Under `GUREN_INTROSPECT=1`, `boot()` stops after registration and `listen()` throws. A provider may add `introspect()`, which runs in place of `register()` under introspection; `isIntrospecting()`, true under the variable and inside `app.introspect()`, is for a check within `register()`. `Router.registeredHandlers()`, `Router.describeMiddleware()` and `Router.routeCount` expose what `definitions()` reduces to names.

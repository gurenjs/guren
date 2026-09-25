---
'@guren/server': minor
---

`RouteDefinition` carries `module`, the `defineModule()` name of the module whose registrar added the route (the outer one, for a module a registrar mounts itself), and has none for the app's own routes. `mountModuleRoutes()` records it once the registrar settles, so a route an async registrar adds after an `await` carries it too, and `app.introspect()` reads each `RouteEntry.module` from it.

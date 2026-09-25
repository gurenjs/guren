---
'@guren/cli': patch
---

The CLI joins the introspected app's routes to the routes file's definitions on the `module` each definition carries, instead of a list of module names kept beside the definitions. With an older `@guren/server`, which does not name the module on a route, `loadRouteDefinitions()` still records it from the module that registered the route.

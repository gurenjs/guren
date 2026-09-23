---
'@guren/server': minor
---

`Application.introspect()` registers every provider and mounts every route without booting or listening, and returns an `AppManifest` (RFC 0026): providers with how each registered, routes with resolved middleware, JSON Schema contracts and module provenance, and the session, auth, cache, storage, queue and attachments configuration read through new `describe()` methods on their managers. Under `GUREN_INTROSPECT=1` (`isIntrospecting()`), `boot()` stops after registration and `listen()` throws. A provider or `definePlugin()` definition may add `introspect()`, which runs in place of `register()` under introspection. `Router.registeredHandlers()` and `Router.describeMiddleware()` expose what `definitions()` reduces to names.

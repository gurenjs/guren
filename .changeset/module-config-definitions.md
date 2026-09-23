---
'@guren/server': minor
'@guren/core': minor
---

A module can carry its own config definitions (RFC 0002, RFC 0027 §2). `defineModule({ config: [...] })` takes the same definitions as `createApp({ config })`, conventionally from `modules/<name>/config/<key>.ts`. The app's definitions bind first, then each module's in `createApp({ modules })` order, through the one `ConfigServiceProvider`, which now also registers when only a module carries definitions. Keys stay app-wide: a key the app and a module both define, or two modules define, fails the boot naming both places (`"oauth" has two config definitions, at createApp({ config })[3] and the "auth" module's config[0]`). The duplicate-key error for two root definitions is reworded to the same shape. `GurenModule.config` is optional, so a module literal built without `defineModule()` still typechecks.

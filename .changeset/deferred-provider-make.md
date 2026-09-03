---
'@guren/server': patch
---

Resolve deferred providers through `Container.make()`.

`make()` handed the key to the deferred-provider loader and then read a flag
set from the loader's `.then()`, which never runs before the surrounding
synchronous code finishes — so the flag was always false, the freshly bound
service was never re-read, and every deferred service failed with
`Service "..." not found in container` even though its provider had just
registered it. `ProviderManager.loadDeferredProvider()` worked, but the path
the plugin guide documents (`deferred: true` + `provides`, loaded on first
resolution) did not.

The loader now runs the provider's `register()` synchronously and `make()`
re-reads the bindings after it returns. A synchronous `register()` failure
surfaces from `make()` instead of becoming an unhandled rejection, and a
deferred `register()` that binds asynchronously gets an error saying so —
`make()` cannot await it. `boot()` may still be async; it runs after that
first resolution, and a later `loadDeferredProvider()` for the same service
resolves once that boot has finished.

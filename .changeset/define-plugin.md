---
'@guren/server': minor
---

Add `definePlugin()` helper for authoring configurable plugins without ServiceProvider boilerplate. Each factory call returns an independent provider class with the configuration captured in a closure, so the same plugin can be registered multiple times with different configurations — replacing the unsafe static-config pattern previously shown in the plugin authoring guide. Supports `deferred`/`provides` for lazy loading. Exported from `@guren/core` alongside `PluginDefinition` and `PluginFactory` types. (RFC 0001, Part A)

`ProviderManager.register()` now throws when a deferred provider declares no `provides` services — previously such a provider was silently dropped and could never load.

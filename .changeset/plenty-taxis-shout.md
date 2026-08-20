---
"@guren/server": minor
---

Remove `ApplicationOptions.discover`. The option was accepted and silently ignored since it was introduced — nothing in `Application` ever read it, so no discovery ran and no behavior exists to migrate. This ships as a minor deliberately: it is a type-surface bug fix, not an API removal. JavaScript apps are unaffected either way, and TypeScript code passing `discover: true` now gets a compile error naming the truth instead of a silent no-op. The `AutoDiscovery` class remains available as a standalone scanner; its docs now state that registration in Guren is explicit and show how to feed scan results into the registries yourself.

---
"@guren/server": patch
---

Make `Router<M>` contravariant in its middleware-alias parameter. `M` sat only in method parameters, which TypeScript compares bivariantly, so a `Router` that never registered an alias could be passed where a `Router<'auth'>` was required; the mismatch surfaced at `mount()` as "Middleware "auth" is not registered". A registrar typed `Router<'auth'>` must now actually receive a router on which `aliasMiddleware('auth', …)` was called and its return captured. A router carrying more aliases than the parameter names still passes.

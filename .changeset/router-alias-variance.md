---
"@guren/server": minor
"@guren/core": minor
---

Make `Router<M>`, `RouteBuilder<M>` and the `middleware()` scope builder contravariant in the middleware-alias parameter, with TypeScript's `in` variance annotation.

`M` sat only in method parameters, which TypeScript compares bivariantly, so a router that never registered an alias could be passed where a `Router<'auth'>` was required; the mismatch surfaced at `mount()` as `Middleware "auth" is not registered`. A router carrying more aliases than the parameter names still passes.

The tightening rejects three shapes that used to compile. None is a runtime behaviour change; each was already broken at `mount()` or was never satisfiable.

- A registrar annotated `Router<'auth'>` is no longer assignable to `RouteRegistration`, the type of `createApp({ routes })`. An entry registrar takes `Router` and registers the aliases itself, capturing what `aliasMiddleware()` returns; a registrar that reads an alias is a function the entry one calls.
- `Router<string>` is not a valid spelling of "any aliases". It asks for a router carrying every possible alias, which nothing satisfies. Write `Router`, that is `Router<never>`.
- A `group()` callback cannot annotate aliases the outer router lacks: `router.middleware('auth').group((inner: Router<'auth' | 'guest'>) => …)` on a `Router<'auth'>` is rejected, because the callback reads a name the router never registered.

One hole stays open. An inline `registrarNeedingAuth(new Router())` still compiles, because `M` has nothing to fix it and is inferred from the parameter. Only a router whose `M` is already settled, by a variable annotation or by an `aliasMiddleware()` chain, is checked.

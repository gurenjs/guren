---
"@guren/server": patch
"@guren/cli": patch
---

Accept controller actions alongside route contract options inside `router.middleware(...)` chains

`router.middleware('auth').post('/posts', { name: 'posts.store', body: Schema }, [PostController, 'store'])`
raised TS2769 even though it worked at runtime: the middleware-scoped builder carried only
two overloads per HTTP verb, missing the contract-options + `[Controller, 'method']` variant
the router itself has. All five verbs now expose it, so the direct chain no longer needs a
`.group()` wrapper to compile.

Route docs and the `make:feature` next-steps hint now capture the `aliasMiddleware()` return
value, which later `.middleware()` calls require — a bare call registers the handler at runtime
but leaves the alias name invisible to the type system.

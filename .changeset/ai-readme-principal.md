---
'@guren/plugin-ai': patch
---

Fix the README's controller snippet, which passed a principal `as()` cannot use. `this.auth.user()` resolves to `Authenticatable`, which carries no `id`, and it can be `null`; `as(null)` is an anonymous run restricted to read-only tools, so the snippet's own `tickets_update` is refused at `as()`, which calls `tools()` eagerly. Written inline the call still compiles, because `user<T>()` infers `T` from the argument position and the generic collapses to whatever `as()` accepts; hoisted into a variable the same call is a TS2345. The README now shows `await this.auth.userOrFail<{ id: number }>()`.

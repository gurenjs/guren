---
'@guren/server': patch
---

Fix the `FormRequest` JSDoc example that documented a no-op authorization gate

`AuthContext.user()` is async, but `FormRequest`'s `protected user()` was
declared `(): unknown` and returned its result unawaited. The class JSDoc built
its `authorize()` example on that:

```ts
authorize() {
  return this.user() !== null   // a pending promise — always true
}
```

An app that copied it authorized every request, including logged-out ones. The
precondition is an attached auth context, which is the normal case:
`Application` attaches a fallback one in its constructor even when the app
configures no `options.auth`. The `unknown` return type kept `tsc` quiet.

`user()` is now `protected async user<TUser>(): Promise<TUser | null>` and the
example awaits it. `authorize()` already accepted `boolean | Promise<boolean>`
and `handle()` already awaited it, so nothing else moves — for callers that
await, runtime behavior is identical before and after.

`handle()`'s JSDoc also claimed it was `@internal Called by
Controller.validate()`. That method does not exist and nothing in the framework
calls `handle()`, so it now documents the real entry point:
`await new StorePostRequest().handle(this.ctx)`.

### Note for subclasses that override `user()`

The new signature is source-incompatible for a subclass that **overrides** the
helper — `protected user(): unknown` no longer satisfies the base declaration.
It is `protected` on a deprecated class, so this is not public API surface, and
subclasses that only *call* `user()` are unaffected.

Migration: change an override to `protected async user<TUser = unknown>():
Promise<TUser | null>`. Separately, a subclass that copied the old
`this.user() !== null` line keeps compiling and keeps returning true — a
promise is still legally `!== null` — so rewrite it as
`(await this.user()) !== null`.

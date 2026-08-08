---
'@guren/server': patch
---

Fix a policy denial being read as an approval

`Policy` ships `deny()`, `denyWithStatus()` and `denyAsNotFound()`, which return
an `AuthorizationResponse` object rather than `false`. `Gate.check()` returned
the policy method's value unchanged, so every consumer truthy-tested that object
and read the denial as an approval: `authorize()` did not throw, `allows()` and
`Controller.can()` returned truthy, `denies()` returned `false`, `inspect()`
reported `allowed: true`, and `authorizeMiddleware`'s `if (!authorized)` guard
passed. A policy written as

```typescript
update(user: AuthUser | null, post: Post) {
  return user?.id === post.authorId ? true : this.deny('You do not own this post.')
}
```

therefore let any user through the exact check meant to stop them. Nothing
flagged it: the helpers are `protected`, so a policy ability method is their only
possible call site, and `PolicyMethod` was exported but never applied to policy
classes, so the method's return type was inferred from its body with nothing to
check it against.

`Gate` now normalizes every policy and gate return value through one path. An
`AuthorizationResponse` is honoured as written, `true` allows, and anything else
denies — unknown shapes fail closed rather than open. A new `checkResponse()`
keeps the full response so `inspect()` reports the policy's own message, and
`authorize()` propagates `denyWithStatus()` / `denyAsNotFound()` into the thrown
exception's status instead of flattening every denial to 403.

`PolicyMethod` and `definePolicy()` now accept `PolicyResult`
(`boolean | AuthorizationResponse`), so the type matches what `Policy` has always
offered. `PolicyResult` and the `isAuthorizationResponse()` guard are exported.

---
'@guren/server': minor
---

`authorizeResourceMiddleware` now fails closed on HTTP methods outside its built-in mapping

Previously an unknown verb (e.g. a custom `PURGE` route registered via `router.on()`) fell through to the `view` ability, so a user with only view permission passed the gate in front of a handler that may mutate state. Unknown methods are now denied with a 403 (`AuthorizationException`).

- The built-in mapping is now explicit: GET/HEAD/QUERY → `view` (QUERY is safe per RFC 10008, matching CSRF and `guren audit` classifications), POST → `create`, PUT/PATCH → `update`, DELETE → `delete`. Behavior for these methods is unchanged.
- Custom verbs can opt in via the new `abilityFor` option (`AuthorizeResourceOptions`): return an ability name for a method, or `undefined` to fall back to the built-in mapping.

```ts
authorizeResourceMiddleware(getPost, {
  abilityFor: (method) => (method === 'PURGE' ? 'delete' : undefined),
})
```

If you relied on custom verbs passing as `view` checks, add an `abilityFor` mapping for them.

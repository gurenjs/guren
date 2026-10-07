---
"@guren/cli": minor
---

`guren audit` reads two more shapes of request data that can skip `fillable` (RFC 0031). The force-write review prompt (`force-write-request-data:*`) now fires when a force write sits beside any controller call that returns request data, `this.validated()`, `input()`, `only()` and `except()` included, not only `validateBody()`. A new warning, `set-spread:*`, flags a spread written inside the `set` option of `create()` or `update()` (`Post.create(data, { set: { ...x } })`), which the ORM refuses only when the spread carries a fillable key.

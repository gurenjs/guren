---
'@guren/server': patch
---

`Controller.except()` now drops a `__proto__` key from the request body. It assigned every body key onto a plain object, so a JSON body such as `{"name":"x","__proto__":{"role":"admin"}}` made the sender's object the result's prototype, and `except('role')` still let `role` through to `in` checks and property reads (`filterFillable()` copies a key it finds with `in`). The result now always has `Object.prototype` as its prototype and the same own keys as before; a key the sender nests under `__proto__` is no longer readable from it.

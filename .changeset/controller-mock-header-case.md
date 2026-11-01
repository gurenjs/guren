---
'@guren/testing': patch
---

The `Controller` that `createGurenControllerModule()` returns merges the headers given to `inertia()` and `text()` case-insensitively, as `@guren/server`'s controller does, so a test of `this.text(csv, { headers: { 'content-type': 'text/csv' } })` sees the caller's type rather than two joined values.

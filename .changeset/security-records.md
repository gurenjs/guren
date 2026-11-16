---
'@guren/cli': minor
---

`change:lane` and `change:evidence` now judge `authorization-removed` and `validation-removed` (RFC 0040 §3) from per-route security records, read by the new `guren change:records` in the same two exports the audit uses. A guard gone from a route's middleware chain, or an `authorize()`, `can()` or `auth.userOrFail()` call gone from its action, is `authorization-removed`; a contract schema or a validate call gone is `validation-removed`; both are always `high`. Routes are matched by controller action, then by method and path. A record that cannot be ordered against the base is not judged at `high`, and a base that cannot be rebuilt from the install on disk at `medium`, as before. `record.json` now carries the head's records. The always-high list in `REVIEW.md`'s generated block gains the two facts, so an app with a `REVIEW.md` reads as stale until `bunx guren change:policy` runs again.

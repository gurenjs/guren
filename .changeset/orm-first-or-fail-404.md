---
'@guren/orm': patch
---

`QueryBuilder.firstOrFail()` now throws `ModelNotFoundException` (rendered as HTTP 404) instead of a plain `Error` (which rendered as 500), matching `Model.findOrFail()`.

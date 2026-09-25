---
'@guren/cli': patch
---

The ORM rule file shipped by `guren agent:init` and the API digest `guren context` prints now show `whereNull()` / `whereNotNull()` and the three-argument `where(field, 'is null', null)` next to `where`, and say that the two-argument `where(field, 'is null')` is an equality check that throws.

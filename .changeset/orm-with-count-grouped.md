---
"@guren/orm": patch
---

`withCount()` issues one `SELECT fk, COUNT(*) ... GROUP BY fk` per relation instead of loading every related row and counting in JS (`morphMany` loaded the whole relation). The related model's global scopes still apply, so a soft-deleted child is not counted. The IN list behind `withCount()` and every eager load (`hasMany`, `hasOne`, `belongsTo`, `belongsToMany`, `hasManyThrough`, `morphMany`, `morphTo`) is now split into chunks of 500 parent keys, under SQLite's default limit of 999 bound variables; a `with()` constraint's `limit()` applies per chunk.

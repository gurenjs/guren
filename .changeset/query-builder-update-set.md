---
"@guren/orm": minor
---

`QueryBuilder.update(data, { set })` writes columns the server chooses beside the filtered data, as `Model.update(where, data, { set })` does (RFC 0031). `set` goes through the same `filterFillable()` step, so it refuses `id`, a credential column, a fillable key, a key `data` also carries, and a model with no `fillable`.

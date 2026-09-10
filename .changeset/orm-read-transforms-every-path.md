---
"@guren/orm": patch
---

Casts and accessors now apply on every read path. `Model.all()` and `Model.find()` applied them only when they talked to the adapter directly: a `where().get()`, `paginate()`, `orderBy()`, an eager-loaded relation, or `all()` on a model carrying a global scope (SoftDeletes included) handed back raw rows, so a `json` cast came back as a string and accessor fields were missing. The QueryBuilder now runs the model's read transforms on every result set it materialises, which is also what gives an eager-loaded relation the related model's casts, and the adapter-direct `orderBy()` / `paginate()` paths run them too.

---
"@guren/orm": minor
---

Casts and accessors now apply on every read path, and an eager load is keyed
before they run.

`Model.all()` and `Model.find()` applied them only when they talked to the
adapter directly: a `where().get()`, `paginate()`, `orderBy()`, an eager-loaded
relation, or `all()` on a model carrying a global scope (SoftDeletes included)
handed back raw rows, so a `json` cast came back as a string and accessor fields
were missing. Every terminal that returns rows now runs the model's transforms,
and an eager-loaded relation carries the related model's.

A relation loader matches child rows to their parents by value, so the
transforms run after the join rather than before it. A model casting its own
`id`, or a child model casting the foreign key, would otherwise get every
relation back empty. One consequence to know about: a parent accessor now sees
the relations the row was loaded with, where before it saw nothing.

A row `select()` narrowed skips accessors, since one reading a column the
projection left out fabricated a value from `undefined`. Casts still apply to
the columns that are there.

`Model.paginate()` and `Model.withPaginate()` are the query builder's
`paginate()` on both arms now, so page sanitising, the count and `meta` have one
implementation rather than two that agreed by inspection.

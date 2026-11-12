---
"@guren/orm": minor
"@guren/core": minor
"@guren/cli": patch
---

Models and the query builder gain `increment()` and `decrement()`: `Post.increment({ id }, 'views')` and `Product.where({ id }).where('stock', '>=', 2).decrement('stock', 2)`. Each runs `column = column + amount` in one `UPDATE`, so concurrent requests lose no count, and resolves to the number of rows it changed on every dialect, which lets a condition act as a guard. The amount defaults to `1`; a `numeric` or `decimal` column also takes a decimal string such as `'10.50'`, which PostgreSQL and MySQL add exactly. A column that is not numeric is refused, as is a fractional amount on an integer column. Global scopes apply as they do to `update()`; `fillable`, mutators and hooks do not run. `@guren/core` re-exports the new `IncrementAmount` type, and a custom adapter supports the methods by implementing `incrementAdvanced`.

`guren audit`, `guren check` and the plan impact scan read the two methods as writes of the column they name, and the agent harness reference lists them.

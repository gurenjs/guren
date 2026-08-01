---
"@guren/cli": patch
---

Check the table a model actually binds, not one guessed from its class name

`guren check`'s model-schema result derived a table name from the model class
(`Post` → `posts`) and asserted that string appeared somewhere in the schema
file's raw text. That reported two kinds of nonsense: a model binding the
wrong identifier passed as long as the guessed name occurred anywhere in the
schema — a column name or a comment was enough — and any model not named
after its table (`Post` bound to `blog_posts`, `User` bound to `accounts`)
warned even though it was correct.

The check now resolves the identifier the model actually binds —
`defineModel(x)`, `static table = x`, or either reached through a mixin like
`SoftDeletes(defineModel(x))` — and matches it against the tables the
project's schema declares, following an aliased import
(`import { posts as postTable }`) back to the schema's exported name first.
This is the same model-to-table join `guren context <Entity>` and `guren
audit` already use.

A model whose binding cannot be read, or a schema that declares no readable
tables, is skipped rather than warned on — neither is evidence of a problem.

Still informational: this result is a `warn` in the core suite and does not
set the exit code.

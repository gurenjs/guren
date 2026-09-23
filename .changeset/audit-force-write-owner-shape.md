---
'@guren/cli': patch
'@guren/orm': patch
---

`guren audit` no longer warns on a force write that spreads a validated body and sets the owner from the session, such as `Post.forceCreate({ ...data, authorId: user.id })` after `const data = await this.validateBody(schema)`. That is the pattern the tutorial teaches for a column kept out of `fillable`. A force write that spreads anything else, adds no server-set column, or takes a value from the request still warns.

`MassAssignmentException` now says to add a field to `fillable` only when a request may set it, and to write any other field with `forceCreate()`/`forceUpdate()` from a value the server chose.

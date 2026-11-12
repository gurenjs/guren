---
'@guren/cli': patch
---

`guren check` and `guren audit` no longer read `createHash(algo).update(data)`, `storage.disk().delete(path)`, `cache().store().delete(key)` or `new PostPolicy().delete(user, post)` as a record write. A chained `update()`, `delete()`, `forceDelete()` or (in an in-process agent's local tool) `create()` counts only when the chain starts at a PascalCase name, the rule `increment()` and `decrement()` already followed. The annotation rules for agent routes (`readOnlyHint`, `destructiveHint: false`) and the local-tool listing read through it. A chain written with `?.` (`Post.where(…)?.update(…)`) is now counted.

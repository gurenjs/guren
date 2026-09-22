---
"@guren/orm": patch
---

`SoftDeletes` models now run the `deleting` and `deleted` hooks and observers on `delete()` and `forceDelete()`, so a `deleting` callback that returns `false` stops a soft delete as the documentation describes. An observer registered with `observe()` inside a lifecycle callback now applies from the next write rather than joining the one in progress. Model create, update, and delete share one internal lifecycle sequence.

---
"@guren/orm": patch
---

Load a relation shared by several eager-load paths exactly once

`with('posts.comments', 'posts.tags')` walked each path independently, so the
shared `posts` head was loaded twice and the second pass replaced the very row
objects the first had attached children to. Only the last-named path survived,
with no error raised. Eager-load paths are now grouped by their head segment
and each level is loaded once, so sibling branches all land on the same records
regardless of the order they are named in. The same fix applies to
`Model.with()`, `findWith()`, `findWithOrFail()` and `withPaginate()`, which
had the same defect.

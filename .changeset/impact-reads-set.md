---
"@guren/cli": patch
---

Plan Impact lists the columns a `set` option writes (RFC 0031). `Post.create(data, { set: { authorId } })`, `Post.update(where, data, { set })` and the builder's `update(data, { set })` now report `authorId` as a write, as the same key in the data did. Write options the scan cannot see, held in a variable or spread, are reported as an opaque write instead of being skipped.

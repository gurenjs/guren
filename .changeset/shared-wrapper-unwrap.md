---
"@guren/server": patch
"@guren/cli": patch
---

Host the single-child wrapper unwrap step once, in `internal/zod-compat`.

Three walks look through zod's wrappers for different reasons — finding the
object behind a params schema, rendering a TypeScript type, deciding whether a
property may be omitted — and each carried its own copy of the traversal. The
copies agreed, but nothing made them: a wrapper name or pipe direction known to
one and not another silently changes an answer, which is the whole reason the
vocabulary itself already lived in one place.

`unwrapSingleChild(schema, io)` now applies that vocabulary for all of them.
What each caller *concludes* from a wrapper stays with the caller, because those
conclusions legitimately differ: the CLI's type renderer reads only the side of
a `.pipe()` it renders so presence matches the type it names, while the JSON
Schema walker and the route contract check require both sides to permit
omission. No behaviour changes.

Internal by `contributing/api-stability.md` — reachable only through a deep
import, with no stability guarantee. `@guren/cli` is released alongside so its
`@guren/server` range admits the version that introduces the helper it now
reaches through `@guren/core/internal/zod-compat`.

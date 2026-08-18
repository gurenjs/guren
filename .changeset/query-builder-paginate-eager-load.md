---
"@guren/orm": patch
---

Load eager relations in `QueryBuilder.paginate()`

`Post.newQuery().with('author').paginate({ page, perPage })` returned the page
without `author` on any row. `get()` and `first()` both run their rows through
the builder's eager loader, but `paginate()` returned the adapter's rows as-is,
so a `.with()` on the chain was accepted and then silently dropped. The blog
blueprint's `PostController.index` uses exactly this chain, which is why its
posts index never received `author` and `PostResource.whenLoaded('author')`
omitted it without an error.

`paginate()` now attaches every relation named on the builder, the same way
`get()` and `first()` do. `Model.withPaginate()` was the working alternative all
along and is unchanged.

---
"@guren/server": minor
"@guren/core": minor
"@guren/cli": patch
---

Bind a route parameter by a column other than the primary key

`bind: { id: Post }` resolves the parameter with `Post.findOrFail(value)`, so a
`/posts/:slug` route could not use route model binding: the router looked the
slug up as a primary key and answered 404 for every real post. The only way
through was an adapter object (`{ findOrFail: (v) => Post.findOrFail(v, 'slug') }`)
passed to both `bind:` and `this.model()`, which worked by accident of the
structural type and appeared nowhere in the docs.

The `bind` option now also accepts a `[Model, column]` tuple. The router calls
`Post.findOrFail(value, column)` and `this.model(Post)` returns that record, so
the class-only form and the tuple form read the same in the controller:

```ts
router.get('/posts/:id',   { bind: { id: Post } },              [PostController, 'show'])
router.get('/posts/:slug', { bind: { slug: [Post, 'slug'] } },  [PostController, 'show'])

async show() {
  const post = this.model(Post)
}
```

Router-level `router.bind(param, ...)` accepts the same tuple, and its model
bindings — class or tuple — now feed `this.model(Post)` too. Values from
`router.bind()` still arrive as positional arguments after the context, in
path-parameter order; that is the only channel for a custom resolver function,
which has no model class to look the record up by. Neither ever landed on the
Hono context: the routing guide told readers to use `this.ctx.get('post')`,
which has always been `undefined`. The English and Japanese guides, the agent
harness rules, and the `guren context` API digest now describe the two channels
that exist. A router test pins each of them, so the docs cannot drift from the
implementation unnoticed again.

`this.model(Post)` is also typed as the model's record now. Its return type
was read off `findOrFail`, which is generic in `this`, so `ReturnType` widened
it to the base row (`Record<string, unknown>`) and `post.id` came back
`unknown` — the docs claimed `PostRecord` all along. The record type now comes
from the `recordType` marker `defineModel()` sets; classes without the marker
keep the previous fallback.

`BindableModel` and the new `RouteModelBinding` type are exported from
`@guren/core` for code that builds `bind` maps outside a route call.

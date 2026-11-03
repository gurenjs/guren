# Routing

Routes map a method and a URL to the code that answers it: a controller action or an inline handler. Each application owns one `Router`. A route file exports a registrar, a function that receives that router and registers routes on it, and `src/app.ts` passes the registrar to `createApp()`.

A route can also carry a contract, the schemas and metadata that validation, codegen and agent tools read. [Route Contracts](./route-contracts.md) explains how to write one, and [OpenAPI](./openapi.md) covers the document generated from them.

## Defining Routes

A scaffolded app's `routes/web.ts` already exports a registrar, `registerWebRoutes`. Add routes inside it:

```ts
// routes/web.ts
import { Router } from '@guren/core'
import PostsController from '@/app/Http/Controllers/PostsController'

export function registerWebRoutes(router: Router): void {
  // Controller tuple — the most common pattern
  router.get('/posts', [PostsController, 'index'])
  router.post('/posts', [PostsController, 'store'])
  router.put('/posts/:id', [PostsController, 'update'])
  router.delete('/posts/:id', [PostsController, 'destroy'])

  // Inline handler — great for lightweight endpoints
  router.get('/health', (ctx) => ctx.json({ status: 'ok' }))
}
```

Available methods: `router.get`, `router.post`, `router.put`, `router.patch`, `router.delete`, `router.query` (see [The QUERY Method](#the-query-method)), and the generic `router.on(method, path, handler)`.

`src/app.ts` passes the registrar to `createApp()`. The scaffold's file passes more options than this; only `routes` matters here:

```ts
// src/app.ts
import { createApp } from '@guren/core'
import { registerWebRoutes } from '@/routes/web'

const app = createApp({
  routes: registerWebRoutes,
})

export default app
```

## Route Parameters

Dynamic segments use `:param` syntax:

```ts
router.get('/posts/:id', [PostsController, 'show'])
router.get('/users/:userId/posts/:postId', [PostsController, 'showForUser'])
```

Read them in the controller:

```ts
const id = this.ctx.req.param('id')
const userId = this.ctx.req.param('userId')
```

Hono's pattern syntax applies:

| Pattern | Matches |
|---------|---------|
| `/posts/:id?` | `/posts` and `/posts/42` (optional segment) |
| `/items/:id{[0-9]+}` | `/items/42`, not `/items/abc` (regex constraint) |
| `/files/:path{.+}` | `/files/a/b/c` (several segments) |

Avoid `/:slug*`. It is not a Hono wildcard: it registers a one-segment parameter literally named `slug*`, so `/files/x/y` returns 404.

> [!NOTE]
> For large apps, split routes into multiple registrars (`routes/api.ts`, `routes/admin.ts`) and compose them from `src/app.ts`.

## Route Groups

Group routes under a shared prefix to avoid repetition:

```ts
export function registerWebRoutes(router: Router): void {
  router.group('/posts', (posts) => {
    posts.get('/', [PostsController, 'index'])      // GET /posts
    posts.get('/:id', [PostsController, 'show'])    // GET /posts/:id
    posts.post('/', [PostsController, 'store'])     // POST /posts
  })
}
```

Groups nest naturally. Prefixes combine automatically:

```ts
router.group('/admin', (admin) => {
  admin.group('/users', (users) => {
    users.get('/', [AdminUsersController, 'index']) // GET /admin/users
  })
})
```

## Named Routes

Give routes a name, then generate URLs by name instead of hardcoding paths:

```ts
router.get('/posts/:id', [PostsController, 'show']).name('posts.show')

// Later, generate the URL
const url = router.route('posts.show', { id: 42 })
// => '/posts/42'
```

This keeps your code resilient to path changes. If you rename `/posts` to `/articles`, only the route definition changes.

## Middleware

Attach middleware to a route with `.middleware()`, or to a set of routes with `router.middleware().group()`. Names you register with `aliasMiddleware()` can be used in place of functions. The [Middleware guide](./middleware.md) covers groups, execution order and the built-in middleware.

### Registering Aliases

Give middleware functions short names so you can reference them as strings:

```ts
import { Router, requireAuthenticated } from '@guren/core'
import { requireAdmin } from '@/app/Http/middleware/admin'

export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated())
    .aliasMiddleware('admin', requireAdmin())

  router.get('/admin', [AdminController, 'index']).middleware('auth', 'admin')

  router.middleware('auth').group((auth) => {
    auth.get('/dashboard', [DashboardController, 'index'])
    auth.get('/settings', [SettingsController, 'index'])
  })
}
```

> [!IMPORTANT]
> `aliasMiddleware()` returns a **new `Router` type** carrying the alias name it just registered. Call it without capturing the result and the name never reaches the type, so a later `.middleware('auth')` fails to compile. Always chain and assign, as above.
>
> The type travels across functions too. A registrar typed `Router<'auth' | 'guest'>` only accepts a router on which both names were aliased and the result captured, so hand it the captured `router` rather than the `baseRouter` it came from. The entry registrar itself takes plain `Router`: it is the one that registers the aliases, and `createApp({ routes })` hands it a router carrying none.

## Route Contracts

The second argument of a route method can be an options object holding Zod schemas for `params`, `query`, `body` and `output`, plus `name`, `bind` and `agent` metadata. Requests are validated against those schemas before the action runs, and codegen, the OpenAPI document and agent tools are built from the same definitions:

```ts
router.post('/posts', { body: CreatePostSchema, name: 'posts.store' }, [PostsController, 'store'])
```

[Route Contracts](./route-contracts.md) describes each field. The `bind` map is described under [Route Model Binding](#route-model-binding) below.

## Route Model Binding

Without model binding, every controller method starts with the same boilerplate:

```ts
// Before: manual lookup in every method
async show() {
  const post = await Post.findOrFail(this.ctx.req.param('id'))
  return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
}
```

With model binding, Guren resolves the model automatically. Declare the binding with the `bind` field of the route's options (see [Route Contracts](#route-contracts)) and read the record in the controller with `this.model()`:

```ts
// routes/web.ts — :id is looked up with Post.findOrFail(id)
router.get('/posts/:id', { bind: { id: Post }, name: 'posts.show' }, [PostsController, 'show'])

// Controller receives the resolved model — no lookup needed
async show() {
  const post = this.model(Post)  // typed as PostRecord
  return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
}
```

If the record is not found, a 404 is returned automatically.

### Binding by another column

The class alone always looks up by primary key. To resolve a slug (or any other unique column), bind a `[Model, column]` tuple. The router calls `Post.findOrFail(value, 'slug')` and `this.model(Post)` returns the same record:

```ts
router.get('/posts/:slug', { bind: { slug: [Post, 'slug'] }, name: 'posts.show' }, [PostsController, 'show'])

async show() {
  const post = this.model(Post)  // resolved by slug
  // ...
}
```

The column name is a plain string: a misspelled column fails the query rather than returning 404, so keep it aligned with your schema. When the same parameter is bound both on the router (below) and on the route, the route's own `bind` wins and the record is looked up once.

### Router-level bindings

`router.bind(param, ...)` binds a parameter name once for every controller-action route on that router whose path contains it. It accepts the same model forms as the `bind` option (`Post` or `[Post, 'slug']`), plus a custom resolver function:

```ts
router.bind('post', Post)                    // by primary key
router.bind('post', [Post, 'slug'])          // by slug
router.bind('post', async (value) => Post.where('slug', value).firstOrFail())  // custom resolver

router.get('/posts/:post', [PostsController, 'show'])
```

Router-level bindings reach the controller as **positional arguments after the context**, in path-parameter order. A model binding (`Post` or `[Post, 'slug']`) is also available through `this.model(Post)`; a custom resolver's value is only available positionally, since there is no model class to look it up by:

```ts
import type { Context } from '@guren/core'

async show(_ctx: Context, post: PostRecord) {
  return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
}
```

> [!NOTE]
> Bound values are not stored on the Hono context — `this.ctx.get('post')` returns `undefined`. Use `this.model(Post)` or the positional argument. Bindings resolve for controller-action routes only; an inline handler receives Hono's `(ctx, next)` and has to look the record up itself.

## Resource Routes

`router.resource()` generates a full set of RESTful routes from a single line:

```ts
router.resource('/posts', PostsController)
```

This registers:

| Method | Path | Action | Name |
|--------|------|--------|------|
| GET | `/posts` | `index` | `posts.index` |
| GET | `/posts/create` | `create` | `posts.create` |
| POST | `/posts` | `store` | `posts.store` |
| GET | `/posts/:id` | `show` | `posts.show` |
| GET | `/posts/:id/edit` | `edit` | `posts.edit` |
| PUT | `/posts/:id` | `update` | `posts.update` |
| DELETE | `/posts/:id` | `destroy` | `posts.destroy` |

Only methods that exist on the controller are registered. Scope the routes with options:

```ts
// API-only — skip create/edit (those are for HTML forms)
router.resource('/posts', PostsController, {
  only: ['index', 'show', 'store', 'update', 'destroy'],
})

// Custom parameter name
router.resource('/posts', PostsController, { param: 'post' })
```

## The QUERY Method

`router.query()` registers a route for the HTTP QUERY method ([RFC 10008](https://www.rfc-editor.org/info/rfc10008/)): safe and idempotent like GET, but the request carries a body like POST. Use it for search and filter endpoints whose criteria are too complex for a URL:

```ts
import { z } from 'zod'

router.query('/posts/search', {
  name: 'posts.search',
  body: z.object({ keywords: z.array(z.string()), limit: z.number().default(20) }),
}, [PostsController, 'search'])
```

Things to know before reaching for it:

- **Handlers must not mutate state.** QUERY is a safe method, so Guren's CSRF protection skips it. That is sound because browsers cannot send QUERY cross-site without a CORS preflight, but only while the handler really is read-only. To require CSRF tokens anyway, add `'QUERY'` to the CSRF middleware's `methods` option.
- **Call it with `fetch` or the generated API client** (`client.request('posts.search', { body })`). HTML forms and Inertia form helpers cannot send QUERY.
- **Check your deployment path.** Guren's fetch-based adapters (Bun, the Cloudflare Workers and Vercel plugins) do not block QUERY, but verify that your platform's ingress accepts it: some proxies and CDNs reject methods outside the classic set. Notably CloudFront, which the Lambda plugin's asset distribution puts in front of your app, does not forward QUERY. Intermediary caching of QUERY responses is also not widely implemented yet.
- **OpenAPI 3.1 cannot express QUERY**, so `guren openapi:generate` skips QUERY routes with a warning.
- To advertise support to clients, set the `Accept-Query` response header yourself, e.g. `ctx.header('Accept-Query', 'application/json')` on the resource's GET handler.

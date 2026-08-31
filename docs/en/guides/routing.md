# Routing

Routes map URLs to your application logic. They define what happens when a user visits `/posts`, submits a form, or hits an API endpoint. In vNext-style apps, each application owns a `Router` instance and route files export a registrar function instead of mutating a global registry.

## Defining Routes

Create `routes/web.ts` and export a registrar that receives the application router:

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
  router.get('/health', (ctx) => ctx.json({ ok: true }))
}
```

Available methods: `router.get`, `router.post`, `router.put`, `router.patch`, `router.delete`, `router.query`, and the generic `router.on(method, path, handler)`.

### The QUERY method

`router.query()` registers a route for the HTTP QUERY method ([RFC 10008](https://www.rfc-editor.org/info/rfc10008/)): safe and idempotent like GET, but the request carries a body like POST. Use it for search and filter endpoints whose criteria are too complex for a URL:

```ts
import { z } from 'zod'

router.query('/posts/search', {
  name: 'posts.search',
  body: z.object({ keywords: z.array(z.string()), limit: z.number().default(20) }),
}, [PostsController, 'search'])
```

Things to know before reaching for it:

- **Handlers must not mutate state.** QUERY is a safe method, and Guren's CSRF protection skips it on that assumption (browsers cannot send QUERY without a CORS preflight, so cross-site request forgery is not a concern — as long as the handler really is read-only). To force CSRF tokens anyway, add `'QUERY'` to the CSRF middleware's `methods` option.
- **Call it with `fetch` or the generated API client** (`client.request('posts.search', { body })`). HTML forms and Inertia form helpers cannot send QUERY.
- **Check your deployment path.** Guren's fetch-based adapters (Bun, the Cloudflare Workers and Vercel plugins) do not block QUERY, but verify that your platform's ingress accepts it — some proxies and CDNs reject methods outside the classic set. Notably CloudFront, which the Lambda plugin's asset distribution puts in front of your app, does not forward QUERY. Intermediary caching of QUERY responses is also not widely implemented yet.
- **OpenAPI 3.1 cannot express QUERY**, so `guren openapi:generate` skips QUERY routes with a warning.
- To advertise support to clients, set the `Accept-Query` response header yourself, e.g. `ctx.header('Accept-Query', 'application/json')` on the resource's GET handler.

Pass the registrar to `createApp()` in `src/app.ts`:

```ts
// src/app.ts
import { createApp } from '@guren/core'
import registerWebRoutes from '@/routes/web'

const app = createApp({
  routes: registerWebRoutes,
})
```

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

Middleware runs before (or after) your route handler. Guren supports three levels of middleware configuration.

### Registering Aliases

Give middleware functions short names so you can reference them as strings:

```ts
import { Router, requireAuthenticated } from '@guren/core'
import { requireAdmin } from '@/app/Http/middleware/admin'

export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated())
    .aliasMiddleware('admin', requireAdmin())
}
```

> [!IMPORTANT]
> `aliasMiddleware()` returns a **new `Router` type** carrying the alias name it just registered. Call it without capturing the result and the name never reaches the type, so a later `.middleware('auth')` fails to compile. Always chain and assign, as above.

### Middleware Groups

Bundle related middleware under a single name. Group members must already be registered aliases:

```ts
const router = new Router()
  .aliasMiddleware('auth', requireAuthenticated())
  .aliasMiddleware('admin', requireAdmin())
  .aliasMiddleware('session', createSessionMiddleware())
  .aliasMiddleware('csrf', createCsrfMiddleware())
  .aliasMiddleware('throttle', createRateLimitMiddleware({ limit: 60, windowMs: 60_000 }))
  .groupMiddleware('web', ['session', 'csrf'])
  .groupMiddleware('api', ['throttle'])
```

### Applying Middleware

Use `router.middleware().group()` for a set of routes, or `.middleware()` on a single route:

```ts
// Group-level — all routes inside share the middleware
router.middleware('web').group((web) => {
  web.get('/', [HomeController, 'index'])
  web.get('/about', [PagesController, 'about'])
})

// Nested — combine middleware layers
router.middleware('web').group((web) => {
  web.middleware('auth').group((auth) => {
    auth.get('/dashboard', [DashboardController, 'index'])
    auth.get('/settings', [SettingsController, 'index'])
  })
})

// Per-route — for one-off protection
router.get('/admin', [AdminController, 'index']).middleware('auth', 'admin')
```

> [!TIP]
> Keep route files clean by using aliases. Import middleware functions once at the top and alias them, then use string names everywhere else.

## Route Model Binding

Without model binding, every controller method starts with the same boilerplate:

```ts
// Before: manual lookup in every method
async show() {
  const post = await Post.findOrFail(this.ctx.req.param('id'))
  return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
}
```

With model binding, Guren resolves the model automatically. Declare the binding on the route with the `bind` option and read the record in the controller with `this.model()`:

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

The class alone always looks up by primary key. To resolve a slug (or any other unique column), bind a `[Model, column]` tuple — the router calls `Post.findOrFail(value, 'slug')` and `this.model(Post)` returns the same record:

```ts
router.get('/posts/:slug', { bind: { slug: [Post, 'slug'] }, name: 'posts.show' }, [PostsController, 'show'])

async show() {
  const post = this.model(Post)  // resolved by slug
  // ...
}
```

The column name is a plain string — a misspelled column fails the query rather than returning 404, so keep it aligned with your schema. When the same parameter is bound both on the router (below) and on the route, the route's own `bind` wins and the record is looked up once.

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

Optional segments (`router.get('/posts/:id?', handler)`) and regex constraints (`router.get('/items/:id{[0-9]+}', handler)`) follow Hono's pattern support. To match across multiple segments, use a constrained parameter such as `:path{.+}`. Note that `/:slug*` is not Hono wildcard syntax: it registers a single-segment parameter literally named `slug*` — asterisk included, so you would have to read it as `this.ctx.req.param('slug*')` — and `/files/x/y` 404s rather than matching. Avoid it.

> [!NOTE]
> For large apps, split routes into multiple registrars (`routes/api.ts`, `routes/admin.ts`) and compose them from `src/app.ts`.

## Route Contracts

Pass an options object as the second argument to attach Zod schemas and metadata to a route. The framework uses these schemas for request validation, codegen, and OpenAPI document generation. Write them with the zod 4 API (`import { z } from 'zod'`) — schemas authored with the zod v3 API are refused by the structural tools with a warning (see [Validation](./validation.md)).

```ts
import { z } from 'zod'

const CreatePostSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
})

const PostIdParams = z.object({
  id: z.coerce.number().int().positive(),
})

router.post('/posts', {
  body: CreatePostSchema,
  name: 'posts.store',
}, [PostsController, 'store'])

router.get('/posts/:id', {
  params: PostIdParams,
  name: 'posts.show',
}, [PostsController, 'show'])
```

Available contract fields:

| Field | Purpose |
|-------|---------|
| `name` | Route name for URL generation and codegen |
| `params` | Zod schema for path parameters |
| `query` | Zod schema for query string parameters |
| `body` | Zod schema for the request body |
| `output` | Zod schema for the response body — validated on 2xx answers only, so error responses and redirects pass through as the application wrote them |
| `resource` | Resource class response hint — types the API client without a schema |
| `bind` | Route model binding map — `{ id: Post }` (primary key) or `{ slug: [Post, 'slug'] }` (another column) |
| `middlewares` | Array of middleware handlers |

> [!NOTE]
> Repeated query keys reach the `query` schema as arrays (`?tag=a&tag=b` → `{ tag: ['a', 'b'] }`), while a key that appears once stays a string — see [Array-Style Query Parameters](./validation.md#array-style-query-parameters).

### Resource Response Hints

Routes that answer with [API Resources](./api-resources.md) already have a response type — the one codegen extracts from the Resource class into `.guren/data.gen.ts`. Writing an `output` schema for such a route would restate that shape in Zod and leave two copies to drift. Declare the Resource itself instead:

```ts
import { PostResource } from '@/app/Http/Resources/PostResource'

router.query('/posts/search', {
  name: 'posts.search',
  body: PostSearchSchema,
  resource: { data: [PostResource] },
}, [PostController, 'search'])
```

The hint mirrors the JSON the controller builds: a bare class (`resource: PostResource`) for a single resource, a one-element array (`resource: [PostResource]`) for a collection, and a plain object for an envelope — `{ data: [PostResource] }` matches `this.json({ data: PostResource.collection(posts) })`. Nesting works to any depth.

`guren codegen` resolves each class against `app/Http/Resources` — at the project root and inside every `modules/<name>/` — and types the generated API client's `json()` with the assembled shape (`{ data: Data.Post[] }` here). Unlike `output`, nothing runs at request time — the hint is a declaration, checked only in the sense that codegen warns and leaves the response untyped if it names a Resource class it cannot find. When a route sets both, `output` wins: it is the one actually enforced.

> [!NOTE]
> Every leaf of the hint must be a Resource class. An envelope that mixes Resources with plain typed objects — a paginated response's `meta` and `links`, for example — cannot be expressed yet; bind an `output` schema for those routes instead.

### OpenAPI Metadata

Route contracts also accept lightweight OpenAPI annotations. These are stored on the route definition and used by the optional `@guren/openapi` plugin to generate an OpenAPI 3.1 document.

```ts
router.post('/posts', {
  body: CreatePostSchema,
  output: PostResponseSchema,
  name: 'posts.store',
  summary: 'Create a post',
  description: 'Creates a new blog post.',
  tags: ['Posts'],
}, [PostsController, 'store'])

router.get('/posts/:id', {
  params: PostIdParams,
  name: 'posts.show',
  summary: 'Get a post',
  tags: ['Posts'],
  deprecated: false,
}, [PostsController, 'show'])
```

Available OpenAPI fields:

| Field | Type | Purpose |
|-------|------|---------|
| `summary` | `string` | Short description shown in docs UI |
| `description` | `string` | Detailed explanation of the endpoint |
| `tags` | `string[]` | Group endpoints in the docs UI |
| `operationId` | `string` | Override the auto-generated operation ID |
| `deprecated` | `boolean` | Mark endpoint as deprecated |

See the [OpenAPI guide](#openapi) section in the CLI reference for generating the spec document.

### Agent Tools

A named route can be exposed to AI agents as an MCP tool by declaring `agent` metadata on it. Everything about the tool — its input schema, its output schema, its authorization — is derived from the contracts above; nothing is restated.

```ts
// Fluent
router
  .post('/posts', { body: CreatePostSchema, output: PostResponseSchema }, [PostsController, 'store'])
  .name('posts.store')
  .agent({ description: 'Create a blog post as the authenticated user.' })

// Or as a contract key
router.post('/posts', {
  name: 'posts.store',
  body: CreatePostSchema,
  agent: { description: 'Create a blog post as the authenticated user.' },
}, [PostsController, 'store'])
```

`resource()` takes the same metadata per action, and **an action not listed is not exposed**:

```ts
router.resource('/posts', PostsController, {
  agent: {
    index: { description: 'List posts.' },
    show: { description: 'Fetch one post by id.' },
  },
})
```

Exposure is opt-in per route, the tool name is the route name used verbatim, and a route with no `.name()` cannot become a tool. Declaring `agent` in the route options *and* chaining `.agent()` throws — declare it once.

`bunx guren tool:list` shows what an agent would see. For the metadata fields, the input/output derivation rules, the MCP endpoint, token scopes and the audit trail, see the [Agent Interface guide](./agent-interface.md).

## OpenAPI Document Generation

Install the optional `@guren/openapi` package and generate a spec from your route definitions:

```bash
bun add @guren/openapi
bunx guren openapi:generate
```

This reads your routes file, extracts Zod schemas and OpenAPI metadata from route contracts, and writes an OpenAPI 3.1 JSON document to `.guren/openapi.gen.json`.

### CLI Options

```bash
# Custom title and version
bunx guren openapi:generate --title "Blog API" --version "1.0.0"

# Custom output path
bunx guren openapi:generate --out docs/openapi.json

# Include a server URL
bunx guren openapi:generate --server "https://api.example.com"

# Overwrite existing file
bunx guren openapi:generate --force
```

### Mounting Docs at Runtime

You can also serve the OpenAPI spec and an interactive docs UI directly from your application:

```ts
import { createApp } from '@guren/core'
import { mountOpenApiDocs } from '@guren/openapi'

const app = createApp({ routes: registerWebRoutes })

mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
})
```

This mounts two endpoints:

| Path | Description |
|------|-------------|
| `/openapi.json` | The generated OpenAPI 3.1 JSON document |
| `/docs` | Interactive API documentation UI (Scalar) |

Customize the paths with `jsonPath` and `docsPath` options:

```ts
mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
  jsonPath: '/api/openapi.json',
  docsPath: '/api/docs',
})
```

When mounted on an `Application` instance, route definitions are read from the router automatically. For a plain Hono instance, pass `definitions` explicitly.

The `servers` option accepts a function as well as a list. A mounted document is generated per request and the function is called each time, so it can advertise an address the process does not know when it mounts the docs. With `PORT=0` the operating system assigns the port, which therefore exists only once `listen()` has returned it — a fixed list would leave the document, and every client generated from it, pointing at an address nothing is listening on:

```ts
mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
  servers: () => [app.address?.url ?? 'http://localhost:3000'],
})

await app.listen({ port: 0 })
```

`app.address` is where `listen()` bound this app, and `undefined` until it has.
Reading it inside the function is what keeps the entrypoint out of it — nothing
has to carry the address back down into the app that produced it. Mounting
against a plain Hono instance leaves you without an `Application` to ask, so
supply the value the function returns however that app knows it.

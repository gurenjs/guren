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

Available methods: `router.get`, `router.post`, `router.put`, `router.patch`, `router.delete`, and the generic `router.on(method, path, handler)`.

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

With model binding, Guren resolves the model automatically:

```ts
// Register bindings (top of routes file)
router.bind('post', Post)

// Route uses :post instead of :id
router.get('/posts/:post', [PostsController, 'show'])

// Controller receives the resolved model — no lookup needed
async show() {
  const post = this.ctx.get('post') as PostRecord
  return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
}
```

If the record is not found, a 404 is returned automatically.

You can also bind with a custom resolver for slug-based lookups:

```ts
router.bind('post', async (value) => Post.where('slug', value).firstOrFail())
```

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
| `output` | Zod schema for the response body |
| `bind` | Route model binding map |
| `middlewares` | Array of middleware handlers |

> [!NOTE]
> Repeated query keys reach the `query` schema as arrays (`?tag=a&tag=b` → `{ tag: ['a', 'b'] }`), while a key that appears once stays a string — see [Array-Style Query Parameters](./validation.md#array-style-query-parameters).

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

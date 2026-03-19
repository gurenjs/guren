# Routing

Routes map URLs to your application logic. They define what happens when a user visits `/posts`, submits a form, or hits an API endpoint. Guren's routing DSL is declarative, expressive, and keeps your route files readable even as your app grows.

## Defining Routes

Create `routes/web.ts` and import `Route` along with your controllers:

```ts
// routes/web.ts
import { Route } from '@guren/server'
import PostsController from '@/app/Http/Controllers/PostsController'

// Controller tuple — the most common pattern
Route.get('/posts', [PostsController, 'index'])
Route.post('/posts', [PostsController, 'store'])
Route.put('/posts/:id', [PostsController, 'update'])
Route.delete('/posts/:id', [PostsController, 'destroy'])

// Inline handler — great for lightweight endpoints
Route.get('/health', (ctx) => ctx.json({ ok: true }))
```

Available methods: `Route.get`, `Route.post`, `Route.put`, `Route.patch`, `Route.delete`, and the generic `Route.on(method, path, handler)`.

Import your route file in `src/main.ts` so it runs at boot:

```ts
// src/main.ts
import '@/routes/web'

const app = new Application()
await app.boot()
await app.listen()
```

## Route Groups

Group routes under a shared prefix to avoid repetition:

```ts
Route.group('/posts', () => {
  Route.get('/', [PostsController, 'index'])       // GET /posts
  Route.get('/:id', [PostsController, 'show'])     // GET /posts/:id
  Route.post('/', [PostsController, 'store'])       // POST /posts
})
```

Groups nest naturally. Prefixes combine automatically:

```ts
Route.group('/admin', () => {
  Route.group('/users', () => {
    Route.get('/', [AdminUsersController, 'index'])  // GET /admin/users
  })
})
```

## Named Routes

Give routes a name, then generate URLs by name instead of hardcoding paths:

```ts
Route.get('/posts/:id', [PostsController, 'show']).name('posts.show')

// Later, generate the URL
const url = Route.route('posts.show', { id: 42 })
// => '/posts/42'
```

This keeps your code resilient to path changes. If you rename `/posts` to `/articles`, only the route definition changes — every `Route.route()` call still works.

## Middleware

Middleware runs before (or after) your route handler. Guren supports three levels of middleware configuration.

### Registering Aliases

Give middleware functions short names so you can reference them as strings:

```ts
import { Route, requireAuthenticated } from '@guren/server'
import { requireAdmin } from '@/app/Http/middleware/admin'

Route.aliasMiddleware('auth', requireAuthenticated())
Route.aliasMiddleware('admin', requireAdmin())
```

### Middleware Groups

Bundle related middleware under a single name:

```ts
Route.groupMiddleware('web', ['session', 'csrf'])
Route.groupMiddleware('api', ['throttle'])
```

### Applying Middleware

Use `Route.middleware().group()` for a set of routes, or `.middleware()` on a single route:

```ts
// Group-level — all routes inside share the middleware
Route.middleware('web').group(() => {
  Route.get('/', [HomeController, 'index'])
  Route.get('/about', [PagesController, 'about'])
})

// Nested — combine middleware layers
Route.middleware('web').group(() => {
  Route.middleware('auth').group(() => {
    Route.get('/dashboard', [DashboardController, 'index'])
    Route.get('/settings', [SettingsController, 'index'])
  })
})

// Per-route — for one-off protection
Route.get('/admin', [AdminController, 'index']).middleware('auth', 'admin')
```

> [!TIP]
> Keep route files clean by using aliases. Import middleware functions once at the top and alias them, then use string names everywhere else.

## Route Model Binding

Without model binding, every controller method starts with the same boilerplate:

```ts
// Before: manual lookup in every method
async show() {
  const post = await Post.findOrFail(this.ctx.req.param('id'))
  return this.inertia('posts/Show', { post })
}
```

With model binding, Guren resolves the model automatically:

```ts
// Register bindings (top of routes file)
Route.bind('post', Post)

// Route uses :post instead of :id
Route.get('/posts/:post', [PostsController, 'show'])

// Controller receives the resolved model — no lookup needed
async show() {
  const post = this.ctx.get('post') as PostRecord
  return this.inertia('posts/Show', { post })
}
```

If the record is not found, a 404 is returned automatically.

You can also bind with a custom resolver for slug-based lookups:

```ts
Route.bind('post', async (value) => Post.where('slug', value).firstOrFail())
```

## Resource Routes

`Route.resource()` generates a full set of RESTful routes from a single line:

```ts
Route.resource('/posts', PostsController)
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
Route.resource('/posts', PostsController, {
  only: ['index', 'show', 'store', 'update', 'destroy'],
})

// Custom parameter name
Route.resource('/posts', PostsController, { param: 'post' })
```

## Route Parameters

Dynamic segments use `:param` syntax:

```ts
Route.get('/posts/:id', [PostsController, 'show'])
Route.get('/users/:userId/posts/:postId', [PostsController, 'showForUser'])
```

Read them in the controller:

```ts
const id = this.ctx.req.param('id')
const userId = this.ctx.req.param('userId')
```

> [!NOTE]
> For large apps, split routes into multiple files (`routes/api.ts`, `routes/admin.ts`) and import each from `src/main.ts`.

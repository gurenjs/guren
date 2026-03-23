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

export function registerWebRoutes(router: Router): void {
  router.aliasMiddleware('auth', requireAuthenticated())
  router.aliasMiddleware('admin', requireAdmin())
}
```

### Middleware Groups

Bundle related middleware under a single name:

```ts
router.groupMiddleware('web', ['session', 'csrf'])
router.groupMiddleware('api', ['throttle'])
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

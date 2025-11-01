# Routing Guide

Guren provides a Laravel-inspired routing DSL that sits on top of the Hono HTTP server. Routes are registered at boot time by importing `routes/web.ts`, where you define paths, HTTP verbs, controller actions, and optional middleware.

## Basic Usage
Create or edit `routes/web.ts` and import the `Route` helper along with any controllers you use:

```ts
import { Route } from '@guren/server'
import PostsController from '@/app/Http/Controllers/PostsController'

Route.get('/', [PostsController, 'index'])
Route.post('/posts', [PostsController, 'store'])
```

Each route call accepts a path and either:
- a controller tuple `[ControllerClass, 'method']`, or
- an inline handler `(ctx) => new Response('...')`.

Methods available: `Route.get`, `Route.post`, `Route.put`, `Route.patch`, `Route.delete`, and the generic `Route.on(method, path, handler)`.

## Route Groups
Use `Route.group(prefix, callback)` to apply a common path prefix and shared middleware:

```ts
Route.group('/posts', () => {
  Route.get('/', [PostsController, 'index'])
  Route.get('/:id', [PostsController, 'show'])
})
```

Groups can be nested. Prefixes are trimmed automatically, so `/posts` + `/new` becomes `/posts/new`.

## Middleware
Append Hono middleware functions after the handler:

```ts
import { auth } from '@/app/Http/middleware/auth'

Route.post('/posts', [PostsController, 'store'], auth)
```

Middlewares run in the order provided. You can attach different middleware to each route even inside the same group.

See the dedicated [Middleware Guide](./middleware.md) for global registration patterns, built-in helpers, and session support.

## Route Parameters
Dynamic parameters follow Hono’s syntax:

```ts
Route.get('/posts/:id', [PostsController, 'show'])
```

Inside the controller, read parameters via `this.ctx.req.param('id')`.

For optional segments, use Hono’s pattern support (`Route.get('/posts/:id?', handler)`), and for wildcards use `*` (e.g. `/:slug*`).

## Bootstrapping
Import your route files in `src/main.ts` so they register before the application boots:

```ts
// src/main.ts
import '@/routes/web'

const app = new Application()
await app.boot()
await app.listen()
```

The import has side effects only; no explicit export is required from `routes/web.ts`.

## Custom Handlers
Inline handlers give you the full Hono `Context` without a controller:

```ts
Route.get('/health', (ctx) => ctx.json({ ok: true }))
```

This is useful for lightweight endpoints such as health checks or webhooks.

## Tips
- Keep `routes/web.ts` focused on HTTP definitions. Move business logic into controllers or services.
- For large apps, split routes into additional files (e.g. `routes/admin.ts`) and import them from `src/main.ts`.
- Prefer descriptive controller method names (`index`, `show`, `store`, `update`, `destroy`) to stay consistent with the rest of the framework.

With the routing DSL in place, you can express complex HTTP structures while keeping your entry point clean and declarative.

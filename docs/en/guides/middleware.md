# Middleware Guide

Guren routes and applications share Hono's middleware model but expose Laravel-style ergonomics for common tasks. You can register middleware globally on the `Application` instance, per-route via the routing DSL, or through named aliases and groups.

## Global Middleware

```ts
// src/app.ts
import { Application, defineMiddleware } from '@guren/server'

const requestTimer = defineMiddleware(async (ctx, next) => {
  const started = performance.now()
  await next()
  const duration = Math.round(performance.now() - started)
  console.log(`${ctx.req.method} ${ctx.req.path} -> ${ctx.res.status} (${duration}ms)`)
})

const app = new Application()
app.use('*', requestTimer)
```

Global middlewares run before any routes are mounted. Providers can register middleware inside their `boot()` hook using the application instance.

## Route Middleware

```ts
import { Route } from '@guren/server'
import DashboardController from '@/app/Http/Controllers/DashboardController'
import { requireAuthenticated } from '@/app/Http/middleware/auth'

Route.get('/dashboard', [DashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' }))
```

Route middleware only applies to the specific endpoint (or every endpoint nested in a group).

## Middleware Aliases

Register short string names for middleware functions so you can reference them throughout your route files without importing the actual function each time:

```ts
import { Route, requireAuthenticated } from '@guren/server'
import { requireAdmin } from '@/app/Http/middleware/admin'
import { csrfProtection } from '@/app/Http/middleware/csrf'

Route.aliasMiddleware('auth', requireAuthenticated())
Route.aliasMiddleware('admin', requireAdmin())
Route.aliasMiddleware('csrf', csrfProtection())
```

Once registered, use the alias string anywhere middleware is accepted:

```ts
Route.get('/dashboard', [DashboardController, 'index']).middleware('auth')
Route.post('/settings', [SettingsController, 'update']).middleware('auth', 'csrf')
```

## Middleware Groups

Bundle multiple middleware aliases under a single group name. This is useful for stacks that commonly run together:

```ts
Route.groupMiddleware('web', ['session', 'csrf'])
Route.groupMiddleware('api', ['throttle:60'])
```

Apply a group to a route group using `Route.middleware()`:

```ts
Route.middleware('web').group(() => {
  Route.get('/', [HomeController, 'index'])
  Route.get('/about', [PagesController, 'about'])
  Route.get('/contact', [PagesController, 'contact'])
})

Route.middleware('api').group(() => {
  Route.get('/api/posts', [ApiPostController, 'index'])
  Route.post('/api/posts', [ApiPostController, 'store'])
})
```

You can combine groups and individual aliases:

```ts
Route.middleware('web', 'auth').group(() => {
  Route.get('/profile', [ProfileController, 'show'])
  Route.put('/profile', [ProfileController, 'update'])
})
```

## Built-in Helpers

### `defineMiddleware`
Utility wrapper for annotating Hono middleware with Guren's type expectations.

### `createSessionMiddleware`
Factory that attaches a session object to the request context. Sessions are stored in memory by default (`MemorySessionStore`) and persisted using signed cookies.

```ts
import { createSessionMiddleware } from '@guren/server'

app.use('*', createSessionMiddleware())
```

Each request exposes the session through `ctx.get('guren:session')` or the helper `getSessionFromContext(ctx)`.

### Auth Guards

`requireAuthenticated` and `requireGuest` are thin wrappers that expect an auth context to be attached earlier in the pipeline. Pair them with `attachAuthContext`, which stores your guard implementation on the request.

```ts
import { attachAuthContext, requireAuthenticated } from '@guren/server'

app.use('*', attachAuthContext(() => authManager.createGuard('web')))

// Using middleware alias (recommended)
Route.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
Route.aliasMiddleware('guest', requireGuest({ redirectTo: '/dashboard' }))

Route.middleware('auth').group(() => {
  Route.get('/settings', [SettingsController, 'index'])
  Route.get('/dashboard', [DashboardController, 'index'])
})
```

### CSRF Protection

The CSRF middleware validates tokens on state-changing requests (POST, PUT, PATCH, DELETE):

```ts
Route.aliasMiddleware('csrf', csrfProtection())

Route.middleware('csrf').group(() => {
  Route.post('/posts', [PostsController, 'store'])
})
```

### Rate Limiting

Apply rate limiting to routes or groups:

```ts
import { rateLimit } from '@guren/server'

Route.aliasMiddleware('throttle', rateLimit({ max: 60, windowMs: 60_000 }))

Route.middleware('throttle').group(() => {
  Route.post('/api/login', [AuthController, 'login'])
})
```

## Writing Custom Middleware

Create middleware with `defineMiddleware` for full type support:

```ts
import { defineMiddleware } from '@guren/server'

export const requireSubscription = defineMiddleware(async (ctx, next) => {
  const user = await ctx.get('auth')?.user()

  if (!user?.isSubscribed) {
    return ctx.json({ error: 'Subscription required' }, 403)
  }

  await next()
})
```

Register it as an alias for convenient use:

```ts
Route.aliasMiddleware('subscribed', requireSubscription)

Route.middleware('auth', 'subscribed').group(() => {
  Route.get('/premium', [PremiumController, 'index'])
})
```

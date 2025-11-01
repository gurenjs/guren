# Middleware Guide

Guren routes and applications share Hono's middleware model but expose Laravel-style ergonomics for common tasks. You can register middleware globally on the `Application` instance or per-route via the routing DSL.

## Global Middleware

```ts
// src/app.ts
import { Application, defineMiddleware } from '@guren/core'

const requestTimer = defineMiddleware(async (ctx, next) => {
  const started = performance.now()
  await next()
  const duration = Math.round(performance.now() - started)
  console.log(`${ctx.req.method} ${ctx.req.path} -> ${ctx.res.status} (${duration}ms)`)
})

const app = new Application()
app.use('*', requestTimer)
```

Global middlewares run before any routes are mounted. Providers can register middleware inside their `register()` hook using `context.app.use()`.

## Route Middleware

```ts
import { Route } from '@guren/core'
import DashboardController from '@/app/Http/Controllers/DashboardController'
import { requireAuthenticated } from '@/app/Http/middleware/auth'

Route.get('/dashboard', [DashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' }))
```

Route middleware only applies to the specific endpoint (or every endpoint nested in a group).

## Built-in Helpers

### `defineMiddleware`
Utility wrapper for annotating Hono middleware with Guren's type expectations.

### `createSessionMiddleware`
Factory that attaches a session object to the request context. Sessions are stored in memory by default (`MemorySessionStore`) and persisted using signed cookies.

```ts
import { createSessionMiddleware } from '@guren/core'

app.use('*', createSessionMiddleware())
```

Each request exposes the session through `ctx.get('guren:session')` or the helper `getSessionFromContext(ctx)`.

### Auth Guards

`requireAuthenticated` and `requireGuest` are thin wrappers that expect an auth context to be attached earlier in the pipeline. Pair them with `attachAuthContext`, which stores your guard implementation on the request.

```ts
import { attachAuthContext, requireAuthenticated } from '@guren/core'

app.use('*', attachAuthContext(() => authManager.createGuard('web')))
Route.get('/settings', [SettingsController, 'index'], requireAuthenticated({ redirectTo: '/login' }))
```

Auth middleware will evolve into a first-class integration when the authentication module lands, but you can already wire custom guards using this contract.

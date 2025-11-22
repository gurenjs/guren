# Controller Guide

Controllers coordinate incoming HTTP requests, fetch data through models, and return responses with Inertia or JSON payloads. Every controller lives under `app/Http/Controllers/` and extends the framework’s `Controller` base class. This guide also shows how controllers connect to routes defined in `routes/web.ts`.

## Routing Basics
Routes are registered in `routes/web.ts` using a Laravel-like DSL. Import controllers and map them to HTTP verbs and paths:

```ts
// routes/web.ts
import PostsController from '@/app/Http/Controllers/PostsController'

Route.get('/', [PostsController, 'index'])
Route.get('/posts/:id', [PostsController, 'show'])
Route.post('/posts', [PostsController, 'store'])
```

- Each route takes a path and a `[ControllerClass, 'methodName']` tuple.
- `Route.group('/posts', () => { ... })` lets you share prefixes and middleware.
- Register routes once at startup by importing `routes/web.ts` inside `src/main.ts` for its side effects.

For more complex setups, you can create additional route files (e.g. `routes/api.ts`) and import them from `src/main.ts` as well.

See the [Routing Guide](./routing.md) for a deeper dive into groups, middleware, and inline handlers.

## Create a Controller
Use the CLI to scaffold a controller file:

```bash
bunx guren make:controller PostsController
```

The generator places `PostsController.ts` in `app/Http/Controllers/` with a minimal class definition. You can also create the file manually—just ensure it default-exports a class that extends `Controller`.

```ts
// app/Http/Controllers/PostsController.ts
import { Controller } from '@guren/server'
import { Post } from '@/app/Models/Post'

export default class PostsController extends Controller {
  async index() {
    const posts = await Post.all()
    return this.inertia('posts/Index', { posts })
  }
}
```

## Route Registration
Controllers are connected to routes in `routes/web.ts` using the Laravel-style DSL:

```ts
import PostsController from '@/app/Http/Controllers/PostsController'

Route.get('/posts', [PostsController, 'index'])
Route.post('/posts', [PostsController, 'store'])
```

The `[Controller, 'method']` tuple tells Guren which class to instantiate and which method to call. Methods can be asynchronous.

## Accessing the Request
- `this.ctx` exposes the full Hono context, including headers and response helpers.
- `this.request` returns the underlying `Request` object.
- Use `await this.request.json()` or `await this.request.formData()` to read payloads.

## Returning Responses

| Helper | Purpose |
|--------|---------|
| `this.inertia(component, props, options?)` | Render an Inertia page using `resources/js/pages/<component>.tsx`. Returns a `Promise<Response>` so controller actions should be `async` and `return` the call directly. |
| `this.json(data, init?)` | Return JSON. |
| `this.redirect(url, status?)` | Redirect to another location (default status 302). |

Return one of these helpers from each controller method. If you need custom headers, you can create a `Response` manually via `return this.ctx.newResponse(body, init)`.

## Sharing Data Across Methods
Controllers are instantiated per request, so you can set instance fields in one method and reuse them in helpers. For global data (e.g. user information), consider Inertia shared props or middleware.

## Shared Inertia Props
Use `setInertiaSharedProps()` to inject app-wide data (such as the authenticated user) into every Inertia response:

```ts
// config/inertia.ts
import { setInertiaSharedProps, AUTH_CONTEXT_KEY, type AuthContext } from '@guren/server'

setInertiaSharedProps(async (ctx) => {
  const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
  return { auth: { user: await auth?.user() } }
})
```

Augment the exported `InertiaSharedProps` interface to keep props typed across controllers and React pages:

```ts
// types/inertia.d.ts
import type { UserRecord } from '@/app/Models/User'

declare module '@guren/server' {
  interface InertiaSharedProps {
    auth: { user: UserRecord | null }
  }
}
```

When you need a component’s prop type, `InferInertiaProps<ReturnType<Controller['action']>>` includes both the action props and shared props.

## Validation Tips
Guren does not prescribe a validation library. Use your preferred solution (e.g. Zod) within controller methods:

```ts
const data = await this.request.json()
const payload = PostPayload.parse(data)
await Post.create(payload)
```

Handle validation failures by returning `this.inertia()` with errors or `this.json()` with appropriate status codes.

## Testing Controllers
- Invoke controller methods directly in unit tests by constructing the dependencies you need and calling `setContext(ctx)` before the method.
- For end-to-end coverage, interact with the running application via `fetch` or your favourite HTTP client and assert on the responses.

Controllers stay thin when they delegate business logic to models or services. Treat them as orchestration layers that glue together the rest of your application.

### SSR Options

When the SSR bundle is available, Guren renders pages on the server automatically. You can disable or customize this per-response by passing the `ssr` option:

```ts
return this.inertia('posts/Index', props, {
  ssr: {
    enabled: false, // force client-side rendering for this response
  },
})
```

Advanced use cases can provide a custom renderer via `ssr.render`, which receives the page payload and may delegate to utilities like `renderInertiaServer()`.

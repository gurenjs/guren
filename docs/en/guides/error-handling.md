# Error Handling

An exception thrown anywhere in a request ends up at the `ExceptionHandler`, which decides what gets reported and what the client sees. You customize it from a service provider, and an ordinary `try`/`catch` inside a controller handles the errors you want to recover from on the spot. The handler answers differently in development and in production.

## ExceptionHandler

The `ExceptionHandler` decides what is reported and what the client sees for every exception a request throws. The app creates one at boot and installs it as Hono's `onError` handler. Customize it from a service provider's `boot()`, where the container hands you that instance:

```ts
// app/Providers/ExceptionServiceProvider.ts
import { ServiceProvider } from '@guren/core'
import type { ExceptionHandler } from '@guren/core'

class PaymentDeclinedError extends Error {
  constructor(readonly reason: string) {
    super('Payment declined')
  }
}

export class ExceptionServiceProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    const handler = this.container.make<ExceptionHandler>('exception.handler')

    // Expected failures that should not reach your error tracker
    handler.dontReport(PaymentDeclinedError)

    // Runs for every other exception
    handler.report((error) => {
      console.error('[report]', error)
    })

    // A response for one exception class; everything else keeps the default rendering
    handler.render(PaymentDeclinedError, (error, ctx) =>
      ctx.json({ message: error.message, reason: error.reason }, 402),
    )
  }
}
```

Register the provider in `createApp({ providers: [ExceptionServiceProvider] })`.

| Method | What it does |
|---|---|
| `report(callback)` | Adds a reporter. Every reporter runs for each exception not excluded by `dontReport()`; one that throws is logged and the others still run |
| `dontReport(ErrorClass)` | Skips the reporters for that class |
| `render(ErrorClass, renderer)` | Answers that class with your own response. Renderers are tried in registration order, and the first match wins |

A class matches by `instanceof` or by its name, so an exception from another copy of a package still matches. With no reporter registered, the handler logs 5xx exceptions to the console so a production failure is never silent.

## Replacing Hono's `onError`

The exception handler owns Hono's `onError` hook: it is installed while the app boots, after the `boot(hono)` callback runs. A handler you set with `app.hono.onError()` before `app.boot()` is therefore replaced, so customize the exception handler above instead.

To take the hook over completely, register a subclass of `ErrorServiceProvider`. The app then uses it in place of the built-in one:

```ts
// app/Providers/AppErrorServiceProvider.ts
import { ErrorServiceProvider } from '@guren/core'
import type { Hono } from 'hono'

export class AppErrorServiceProvider extends ErrorServiceProvider {
  boot(): void {
    const hono = this.container.make<Hono>('hono')
    hono.onError((error, ctx) => {
      const isDev = process.env.NODE_ENV !== 'production'
      return ctx.json({ error: isDev ? error.message : 'Internal Server Error' }, 500)
    })
  }
}
```

This skips everything the exception handler does, including the status of `HttpException` and `ModelNotFoundException`, so prefer `render()` unless you need that.

## Built-in Exception Classes

Guren provides typed exception classes for common HTTP error scenarios:

```ts
import {
  HttpException,
  NotFoundHttpException,
  AuthenticationException,
  AuthorizationException,
  ValidationException,
  MethodNotAllowedException,
  ModelNotFoundException,
} from '@guren/core'

// 404 Not Found
throw new NotFoundHttpException('Post not found')

// 404 Not Found (thrown automatically by Model.findOrFail())
throw new ModelNotFoundException('Post', 42)

// 401 Unauthorized (thrown automatically by auth.userOrFail())
throw new AuthenticationException('Authentication required')

// 403 Forbidden
throw new AuthorizationException('You do not have permission to edit this post')

// 422 Unprocessable Entity (thrown automatically by validateBody/Query/Params)
throw new ValidationException({ title: ['Title is required'] })

// 405 Method Not Allowed
throw new MethodNotAllowedException('GET method is not allowed for this endpoint')

// Generic HTTP exception with custom status
throw new HttpException(429, 'Rate limit exceeded')
```

### Duck-typed `statusCode`

The `ExceptionHandler` supports any error with a numeric `statusCode` property, not just `HttpException` subclasses. This means `ModelNotFoundException` (exported from `@guren/core`, with `statusCode: 404`) is automatically rendered as a 404 response without any extra configuration. For errors with `statusCode >= 500`, the message is hidden in production (replaced with "Internal Server Error").

## HTTP Exceptions

Throw `HTTPException` to return specific HTTP status codes:

```ts
import { HTTPException } from 'hono/http-exception'
import { Router } from '@guren/core'

const router = new Router()

router.get('/posts/:id', async (ctx) => {
  const post = await Post.find(ctx.req.param('id'))

  if (!post) {
    throw new HTTPException(404, { message: 'Post not found' })
  }

  return ctx.json({ post })
})
```

Common HTTP exceptions:

```ts
// 400 Bad Request
throw new HTTPException(400, { message: 'Invalid request data' })

// 401 Unauthorized
throw new HTTPException(401, { message: 'Authentication required' })

// 403 Forbidden
throw new HTTPException(403, { message: 'Access denied' })

// 404 Not Found
throw new HTTPException(404, { message: 'Resource not found' })

// 422 Unprocessable Entity
throw new HTTPException(422, { message: 'Validation failed' })

// 429 Too Many Requests
throw new HTTPException(429, { message: 'Rate limit exceeded' })

// 500 Internal Server Error
throw new HTTPException(500, { message: 'Server error' })
```

## Not Found Handler

Customize 404 responses:

```ts
app.hono.notFound((ctx) => {
  // Return JSON for API requests
  if (ctx.req.header('Accept')?.includes('application/json')) {
    return ctx.json({ error: 'Not found' }, 404)
  }

  // Return HTML for browser requests
  return ctx.html('<h1>Page Not Found</h1>', 404)
})
```

## Debug Details

While `NODE_ENV` is not `production`, the exception handler keeps a 5xx's own message and adds the exception's name and stack to the JSON body. In production those are dropped, and a browser asking for HTML gets a generic error page instead.

To decide it another way, bind your own handler under `exception.handler` in a provider's `register()`. The framework adds its own renderers in `boot()`, so they attach to yours:

```ts
// app/Providers/ExceptionServiceProvider.ts
import { ServiceProvider, createExceptionHandler } from '@guren/core'

export class ExceptionServiceProvider extends ServiceProvider {
  register(): void {
    this.container.instance('exception.handler', createExceptionHandler({
      // Details only when NODE_ENV is exactly 'development'
      isDebug: () => process.env.NODE_ENV === 'development',
    }))
  }

  // boot() as in the ExceptionHandler section above
}
```

`createApp()` has no `debug` option; this binding is where the choice is made.

## Controller Error Handling

With `validateBody`/`validateQuery`/`validateParams`, `findOrFail`, and `userOrFail`, most error handling is automatic — no try-catch needed:

```ts
import { Controller } from '@guren/core'
import { z } from 'zod'
import { PostResource } from '@/app/Http/Resources/PostResource'
import { pages } from '@/.guren/pages.gen'
import type { UserRecord } from '@/app/Models/User'

const StorePostSchema = z.object({ title: z.string().min(1), content: z.string().min(10) })
const PostIdSchema = z.object({ id: z.coerce.number().int().positive() })

export default class PostController extends Controller {
  async store(): Promise<Response> {
    const data = await this.validateBody(StorePostSchema)  // 422 on failure
    const user = await this.auth.userOrFail<UserRecord>()  // 401 if not logged in
    const post = await Post.create(data, { set: { authorId: user.id } })
    return this.redirect(`/posts/${post.id}`)
  }

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdSchema)       // 422 on invalid params
    const post = await Post.findOrFail(id)                  // 404 if missing
    return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
  }
}
```

The `ExceptionHandler` catches and renders all thrown exceptions automatically. Use try-catch only when you need custom error recovery logic within a specific controller method.

## Validation Errors

Use `formatValidationErrors` to convert Zod errors to a flat object:

```ts
import { formatValidationErrors } from '@guren/core'
import { z } from 'zod'

const schema = z.object({
  email: z.email(),
  password: z.string().min(8),
})

const result = schema.safeParse(data)

if (!result.success) {
  const errors = formatValidationErrors(result.error)
  // { email: 'Invalid email', password: 'String must contain at least 8 character(s)' }
}
```

With a fallback message:

```ts
const errors = formatValidationErrors(result.error, 'Please check your input')
```

## Error Middleware

A middleware cannot catch what a later handler throws. Hono hands the exception to `onError`, which is the exception handler, at the point it is thrown, so a `try { await next() } catch` around `next()` never sees it. Put shared error logic in a reporter or a renderer (see [ExceptionHandler](#exceptionhandler)), and keep `try`/`catch` for code you call directly, as in [Controller Error Handling](#controller-error-handling).

## Inertia Error Pages

With Inertia, a page visit that hits a missing record should land on an error page component rather than a JSON body. Register a renderer for the two not-found exceptions in a provider, and answer non-browser callers with JSON:

```ts
// app/Providers/ErrorPageServiceProvider.ts
import { ModelNotFoundException, NotFoundHttpException, ServiceProvider, inertia } from '@guren/core'
import type { ExceptionHandler } from '@guren/core'

export class ErrorPageServiceProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    const handler = this.container.make<ExceptionHandler>('exception.handler')

    for (const errorClass of [NotFoundHttpException, ModelNotFoundException]) {
      handler.render(errorClass, (error, ctx) => {
        const wantsPage = ctx.req.header('X-Inertia') === 'true'
          || (ctx.req.header('accept') ?? '').includes('text/html')
        if (!wantsPage) return ctx.json({ message: error.message }, 404)

        return inertia('Error', { status: 404, message: error.message }, {
          status: 404,
          request: ctx.req.raw,
          container: this.container,
        })
      })
    }
  }
}
```

Keep these renderers to specific classes. `ValidationException`, `AuthenticationException` and `AuthorizationException` all extend `HttpException`, so a renderer for `HttpException` would also replace how validation, authentication and authorization failures are answered, the validation redirect included.

React error component:

```tsx
// resources/pages/Error.tsx
export default function Error({ status, message }: { status: number; message: string }) {
  const titles: Record<number, string> = {
    404: 'Page Not Found',
    403: 'Forbidden',
    500: 'Server Error',
    503: 'Service Unavailable',
  }

  return (
    <div className="error-page">
      <h1>{status}</h1>
      <h2>{titles[status] ?? 'Error'}</h2>
      <p>{message}</p>
      <a href="/">Go Home</a>
    </div>
  )
}
```

## Database Errors

Use `Model.findOrFail()` instead of manual null-checking. It throws `ModelNotFoundException` (404) automatically:

```ts
// Before — manual null check
async show(): Promise<Response> {
  const post = await Post.find(Number(this.request.param('id')))
  if (!post) {
    throw new HTTPException(404, { message: 'Post not found' })
  }
  return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
}

// After — automatic 404
async show(): Promise<Response> {
  const { id } = this.validateParams(PostIdSchema)
  const post = await Post.findOrFail(id)  // throws ModelNotFoundException (404)
  return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
}
```

## Async Error Boundaries

Wrap async operations with error boundaries:

```ts
async function withErrorBoundary<T>(
  operation: () => Promise<T>,
  fallback: T,
  onError?: (error: unknown) => void
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    onError?.(error)
    return fallback
  }
}

// Usage
const posts = await withErrorBoundary(
  () => Post.all(),
  [],
  (error) => console.error('Failed to fetch posts:', error)
)
```

## Development vs Production

The exception handler already answers differently by environment, so most apps need no code here:

| | Development (`debug` on) | Production |
|---|---|---|
| Message of a 5xx | The exception's own | `Internal Server Error` |
| Exception name and stack | Included in the JSON body | Omitted |

`debug` follows `NODE_ENV`; [Debug Details](#debug-details) shows how to decide it another way. To change what one class of error answers, register a renderer (see [ExceptionHandler](#exceptionhandler)).

## Best Practices

1. **Use the ExceptionHandler** - Centralize error handling logic instead of scattering try-catch blocks.
2. **Always catch async errors** - Unhandled promise rejections can crash your server.
3. **Log errors with context** - Include request ID, user ID, and relevant data.
4. **Use appropriate status codes** - 4xx for client errors, 5xx for server errors.
5. **Don't expose sensitive data** - Hide stack traces and internal details in production.
6. **Provide user-friendly messages** - Technical errors should be translated to helpful messages.
7. **Monitor errors** - Use error tracking services in production.
8. **Use built-in exceptions** - Prefer `NotFoundHttpException`, `AuthorizationException`, etc. over generic `HTTPException`.

# Error Handling

Guren provides multiple layers of error handling, from a centralized `ExceptionHandler` to controller-level exception catching. Built on Hono's robust error handling primitives, you can customize how errors are displayed to users in both development and production.

## ExceptionHandler

The `ExceptionHandler` class provides a centralized place to handle all exceptions thrown by your application. Register it as a service provider or configure it during application boot:

```ts
import { ExceptionHandler } from '@guren/server'

class AppExceptionHandler extends ExceptionHandler {
  // Exceptions that should not be reported to your logging system
  dontReport = [
    'ValidationException',
    'AuthenticationException',
  ]

  // Register custom exception reporting
  register(): void {
    this.reportable('DatabaseException', (error) => {
      // Send to external error tracking service
      errorTracker.captureException(error)
    })
  }

  // Customize the response for specific exceptions
  render(error: Error, ctx: Context): Response {
    if (error instanceof ValidationException) {
      return ctx.json({
        message: 'Validation failed',
        errors: error.errors,
      }, 422)
    }

    return super.render(error, ctx)
  }
}
```

## Global Error Handler

Register a global error handler using Hono's `onError` method on the underlying app:

> Register handlers in `src/app.ts` right after `new Application(...)`, or inside the `boot(hono)` callback. Make sure it is set before `app.boot()`.

```ts
import { Application } from '@guren/server'
import { HTTPException } from 'hono/http-exception'

const app = new Application()

app.hono.onError((error, ctx) => {
  console.error('Unhandled error:', error)

  // Handle HTTP exceptions
  if (error instanceof HTTPException) {
    return ctx.json({
      error: error.message,
      status: error.status,
    }, error.status)
  }

  // Handle all other errors
  const isDev = process.env.NODE_ENV !== 'production'

  return ctx.json({
    error: isDev ? error.message : 'Internal Server Error',
    ...(isDev && { stack: error.stack }),
  }, 500)
})
```

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
} from '@guren/server'
import { ModelNotFoundException } from '@guren/orm'

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

The `ExceptionHandler` supports any error with a numeric `statusCode` property, not just `HttpException` subclasses. This means `ModelNotFoundException` (from `@guren/orm`, which has `statusCode: 404`) is automatically rendered as a 404 response without any extra configuration. For errors with `statusCode >= 500`, the message is hidden in production (replaced with "Internal Server Error").

## HTTP Exceptions

Throw `HTTPException` to return specific HTTP status codes:

```ts
import { HTTPException } from 'hono/http-exception'

Route.get('/posts/:id', async (ctx) => {
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

## Debug Error Page

In development, Guren renders a detailed error page when an unhandled exception occurs. The debug page includes:

- The exception message and class name
- A full stack trace with source file links
- The request details (method, URL, headers)
- Environment and route information

The debug page is enabled automatically when `NODE_ENV` is not set to `production`. To customize its behavior:

```ts
import { Application } from '@guren/server'

const app = new Application({
  debug: process.env.NODE_ENV !== 'production',
})
```

In production, the debug page is replaced with a generic error response that does not expose sensitive information. You can customize the production error page by overriding the `render()` method in your `ExceptionHandler`.

## Controller Error Handling

With `validateBody`/`validateQuery`/`validateParams`, `findOrFail`, and `userOrFail`, most error handling is automatic — no try-catch needed:

```ts
import { Controller } from '@guren/server'
import { z } from 'zod'

const StorePostSchema = z.object({ title: z.string().min(1), content: z.string().min(10) })
const PostIdSchema = z.object({ id: z.coerce.number().int().positive() })

export default class PostController extends Controller {
  async store(): Promise<Response> {
    const data = await this.validateBody(StorePostSchema)  // 422 on failure
    const user = await this.auth.userOrFail()              // 401 if not logged in
    const post = await Post.create({ ...data, authorId: user.id })
    return this.redirect(`/posts/${post.id}`)
  }

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdSchema)       // 422 on invalid params
    const post = await Post.findOrFail(id)                  // 404 if missing
    return this.inertia('posts/Show', { post })
  }
}
```

The `ExceptionHandler` catches and renders all thrown exceptions automatically. Use try-catch only when you need custom error recovery logic within a specific controller method.

## Validation Errors

Use `formatValidationErrors` to convert Zod errors to a flat object:

```ts
import { formatValidationErrors } from '@guren/server'
import { z } from 'zod'

const schema = z.object({
  email: z.string().email(),
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

Create reusable error handling middleware:

```ts
import { defineMiddleware } from '@guren/server'
import { HTTPException } from 'hono/http-exception'

export const errorHandler = defineMiddleware(async (ctx, next) => {
  try {
    await next()
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error // Let the global handler deal with HTTP exceptions
    }

    // Log unexpected errors
    console.error('Unexpected error:', error)

    // Return a generic error response
    return ctx.json({
      error: 'Something went wrong',
    }, 500)
  }
})

// Register globally
app.use('*', errorHandler)
```

## Inertia Error Pages

For Inertia applications, render error components:

```ts
// Global error handler for Inertia
app.hono.onError(async (error, ctx) => {
  const isInertia = ctx.req.header('X-Inertia') === 'true'

  if (isInertia) {
    const status = error instanceof HTTPException ? error.status : 500

    // Return Inertia error page
    return ctx.json({
      component: 'Error',
      props: {
        status,
        message: error.message,
      },
      url: ctx.req.path,
    }, status)
  }

  // Non-Inertia error handling
  return ctx.json({ error: error.message }, 500)
})
```

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
  return this.inertia('posts/Show', { post })
}

// After — automatic 404
async show(): Promise<Response> {
  const { id } = this.validateParams(PostIdSchema)
  const post = await Post.findOrFail(id)  // throws ModelNotFoundException (404)
  return this.inertia('posts/Show', { post })
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

Customize error output based on environment:

```ts
app.hono.onError((error, ctx) => {
  const isDev = process.env.NODE_ENV !== 'production'

  if (isDev) {
    // Show full error in development (or use the built-in debug page)
    return ctx.json({
      error: error.message,
      stack: error.stack,
      name: error.name,
    }, 500)
  }

  // Hide details in production
  return ctx.json({
    error: 'An unexpected error occurred',
    requestId: ctx.get('requestId'), // If using request ID middleware
  }, 500)
})
```

## Best Practices

1. **Use the ExceptionHandler** - Centralize error handling logic instead of scattering try-catch blocks.
2. **Always catch async errors** - Unhandled promise rejections can crash your server.
3. **Log errors with context** - Include request ID, user ID, and relevant data.
4. **Use appropriate status codes** - 4xx for client errors, 5xx for server errors.
5. **Don't expose sensitive data** - Hide stack traces and internal details in production.
6. **Provide user-friendly messages** - Technical errors should be translated to helpful messages.
7. **Monitor errors** - Use error tracking services in production.
8. **Use built-in exceptions** - Prefer `NotFoundHttpException`, `AuthorizationException`, etc. over generic `HTTPException`.

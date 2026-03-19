# Error Handling

Guren provides multiple layers of error handling, from global error handlers to controller-level exception catching. Built on Hono's robust error handling primitives, you can customize how errors are displayed to users.

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

## Controller Error Handling

Handle errors within controllers using try-catch:

```ts
import { Controller, formatValidationErrors } from '@guren/server'

export default class PostController extends Controller {
  async store(): Promise<Response> {
    try {
      const payload = await parseRequestPayload(this.ctx)
      const result = PostSchema.safeParse(payload)

      if (!result.success) {
        return this.json({
          error: 'Validation failed',
          errors: formatValidationErrors(result.error),
        }, { status: 422 })
      }

      const post = await Post.create(result.data)
      return this.redirect(`/posts/${post.id}`)

    } catch (error) {
      console.error('Failed to create post:', error)

      // Return error page for Inertia requests
      return this.inertia('posts/New', {
        errors: { message: 'An unexpected error occurred.' },
      }, { status: 500 })
    }
  }
}
```

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

Handle database-specific errors:

```ts
import { HTTPException } from 'hono/http-exception'

async function findPostOrFail(id: number) {
  const post = await Post.find(id)

  if (!post) {
    throw new HTTPException(404, { message: 'Post not found' })
  }

  return post
}

// Usage in controller
async show(): Promise<Response> {
  const post = await findPostOrFail(Number(this.request.param('id')))
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
    // Show full error in development
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

1. **Always catch async errors** - Unhandled promise rejections can crash your server
2. **Log errors with context** - Include request ID, user ID, and relevant data
3. **Use appropriate status codes** - 4xx for client errors, 5xx for server errors
4. **Don't expose sensitive data** - Hide stack traces and internal details in production
5. **Provide user-friendly messages** - Technical errors should be translated to helpful messages
6. **Monitor errors** - Use error tracking services in production

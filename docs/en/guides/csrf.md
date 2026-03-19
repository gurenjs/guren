# CSRF Protection

Cross-Site Request Forgery (CSRF) protection prevents malicious websites from submitting forms on behalf of authenticated users. Guren provides built-in CSRF middleware that integrates seamlessly with sessions.

## Setup

Enable CSRF protection by adding the middleware to your application:

```ts
// src/app.ts
import { Application, createSessionMiddleware, createCsrfMiddleware } from '@guren/server'

const app = new Application()

// Session middleware is required for CSRF
app.use('*', createSessionMiddleware())
app.use('*', createCsrfMiddleware())
```

The middleware automatically:
- Generates a unique token per session
- Validates tokens on state-changing requests (POST, PUT, PATCH, DELETE)
- Allows safe methods (GET, HEAD, OPTIONS) without validation

## Including the Token in Forms

Use the `csrfField()` helper to generate a hidden input field:

```ts
// In your controller
import { Controller, getCsrfToken, csrfField } from '@guren/server'

export default class FormController extends Controller {
  create() {
    const token = getCsrfToken(this.ctx)
    // Pass to your template/view
    return this.inertia('Form/Create', { csrfToken: token })
  }
}
```

In your frontend form (React example):

```tsx
function CreateForm({ csrfToken }: { csrfToken: string }) {
  return (
    <form method="POST" action="/posts">
      <input type="hidden" name="_csrf" value={csrfToken} />
      {/* form fields */}
      <button type="submit">Create</button>
    </form>
  )
}
```

Or generate the hidden field directly:

```ts
const hiddenField = csrfField(ctx)
// Returns: <input type="hidden" name="_csrf" value="..." />
```

## AJAX Requests

For JavaScript/AJAX requests, include the token in a header:

```ts
// Get token from meta tag or cookie
const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content

fetch('/api/posts', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken,
  },
  body: JSON.stringify({ title: 'Hello' }),
})
```

The middleware checks both the `_csrf` form field and `X-CSRF-Token` header.

## Configuration Options

```ts
createCsrfMiddleware({
  // Custom form field name (default: '_csrf')
  fieldName: '_token',

  // Custom header name (default: 'X-CSRF-Token')
  headerName: 'X-XSRF-Token',

  // Routes to exclude from CSRF validation
  exclude: ['/api/webhooks/*', '/api/public/*'],

  // Custom error handler
  onError: (ctx) => {
    return ctx.json({ error: 'Invalid CSRF token' }, 403)
  },
})
```

## Excluding Routes

Some routes (like webhook endpoints) should skip CSRF validation:

```ts
createCsrfMiddleware({
  exclude: [
    '/api/webhooks/stripe',
    '/api/webhooks/github',
    '/api/public/*', // Wildcard patterns supported
  ],
})
```

## Manual Token Verification

For custom validation logic, use `verifyCsrfToken()`:

```ts
import { verifyCsrfToken, getCsrfToken } from '@guren/server'

Route.post('/custom', async (ctx) => {
  const token = ctx.req.header('X-Custom-Token')

  if (!verifyCsrfToken(ctx, token)) {
    return ctx.json({ error: 'Invalid token' }, 403)
  }

  // Process request...
})
```

## Token Regeneration

Tokens are tied to the session and regenerate when:
- A new session is created
- `session.regenerate()` is called (recommended after login)

```ts
// After successful login
const session = getSessionFromContext(ctx)
await session.regenerate()
// New CSRF token is generated automatically
```

## Security Best Practices

1. **Always use HTTPS** - Tokens can be intercepted over HTTP
2. **Regenerate after login** - Prevents session fixation attacks
3. **Don't expose tokens in URLs** - Use POST bodies or headers
4. **Set secure cookie flags** - The session middleware handles this automatically

## Inertia.js Integration

When using Inertia.js, CSRF is handled automatically through cookies. Ensure your Axios/fetch configuration includes credentials:

```ts
// resources/js/app.tsx
axios.defaults.withCredentials = true
```

Inertia automatically reads the `XSRF-TOKEN` cookie and includes it in requests.

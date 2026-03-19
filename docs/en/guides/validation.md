# Validation

Guren provides a flexible validation system that integrates with Zod and other schema validation libraries. Validate request data at the middleware level or within controllers.

## Quick Start

Use `validateRequest()` middleware with a Zod schema:

```ts
import { Route, validateRequest, getValidatedData } from '@guren/server'
import { z } from 'zod'

const createPostSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(10),
  published: z.boolean().optional().default(false),
})

Route.post('/posts', async (ctx) => {
  const data = getValidatedData<z.infer<typeof createPostSchema>>(ctx)
  // data is fully typed and validated
  return ctx.json({ post: await Post.create(data) })
}, validateRequest(createPostSchema))
```

## Middleware Validation

### `validateRequest(schema)`

Factory that creates validation middleware:

```ts
import { validateRequest } from '@guren/server'
import { z } from 'zod'

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

Route.post('/login', [AuthController, 'login'], validateRequest(schema))
```

By default, validation errors return a 422 response with error details.

### `validateRequestWith(schemaFactory)`

For dynamic schemas based on request context:

```ts
import { validateRequestWith } from '@guren/server'

Route.put('/users/:id', [UserController, 'update'], validateRequestWith((ctx) => {
  const isAdmin = ctx.get('user')?.role === 'admin'

  return z.object({
    name: z.string().min(1),
    email: z.string().email(),
    // Only admins can change roles
    role: isAdmin ? z.enum(['user', 'admin']) : z.never().optional(),
  })
}))
```

## Getting Validated Data

After validation middleware runs, retrieve typed data with `getValidatedData()`:

```ts
import { getValidatedData } from '@guren/server'
import type { z } from 'zod'

Route.post('/posts', async (ctx) => {
  const data = getValidatedData<z.infer<typeof createPostSchema>>(ctx)

  // TypeScript knows the exact shape
  console.log(data.title)  // string
  console.log(data.content) // string
  console.log(data.published) // boolean

  return ctx.json({ post: await Post.create(data) })
}, validateRequest(createPostSchema))
```

## Manual Validation

For validation outside middleware, use `validate()` or `validateSafe()`:

```ts
import { validate, validateSafe } from '@guren/server'

// Throws on validation failure
const data = validate(schema, requestData)

// Returns result object (never throws)
const result = validateSafe(schema, requestData)
if (result.success) {
  console.log(result.data)
} else {
  console.log(result.error)
}
```

## Custom Error Handling

Override the default error response:

```ts
validateRequest(schema, {
  onError: (ctx, error) => {
    // Custom error format
    return ctx.json({
      message: 'Validation failed',
      errors: error.issues.map(issue => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    }, 422)
  },
})
```

## Schema Interface

Guren's validation is schema-library agnostic. Any object implementing `ValidationSchema` works:

```ts
interface ValidationSchema<T> {
  parse(data: unknown): T
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown }
}
```

This means you can use Zod, Valibot, or custom validators:

```ts
// With Valibot
import * as v from 'valibot'

const schema = v.object({
  name: v.string([v.minLength(1)]),
  email: v.string([v.email()]),
})

Route.post('/users', handler, validateRequest(schema))
```

## Common Patterns

### Nested Objects

```ts
const addressSchema = z.object({
  street: z.string(),
  city: z.string(),
  postalCode: z.string().regex(/^\d{5}$/),
})

const userSchema = z.object({
  name: z.string(),
  address: addressSchema,
})
```

### Arrays

```ts
const schema = z.object({
  tags: z.array(z.string()).min(1).max(10),
  items: z.array(z.object({
    productId: z.number(),
    quantity: z.number().positive(),
  })),
})
```

### Optional with Defaults

```ts
const schema = z.object({
  page: z.coerce.number().positive().default(1),
  perPage: z.coerce.number().positive().max(100).default(20),
  sortBy: z.enum(['created', 'updated', 'name']).default('created'),
})
```

### Transformations

```ts
const schema = z.object({
  email: z.string().email().toLowerCase(),
  tags: z.string().transform(s => s.split(',').map(t => t.trim())),
  date: z.string().transform(s => new Date(s)),
})
```

### Refinements

```ts
const schema = z.object({
  password: z.string().min(8),
  confirmPassword: z.string(),
}).refine(data => data.password === data.confirmPassword, {
  message: 'Passwords must match',
  path: ['confirmPassword'],
})
```

## Form Validation Errors

When validation fails, the default response format is:

```json
{
  "error": "Validation failed",
  "issues": [
    {
      "path": ["email"],
      "message": "Invalid email"
    },
    {
      "path": ["password"],
      "message": "String must contain at least 8 character(s)"
    }
  ]
}
```

### Displaying in Inertia

Pass validation errors to your frontend:

```ts
// Controller
async store() {
  try {
    const data = validate(schema, await this.ctx.req.json())
    await User.create(data)
    return this.redirect('/users')
  } catch (error) {
    if (error instanceof z.ZodError) {
      return this.inertia('Users/Create', {
        errors: formatValidationErrors(error),
      })
    }
    throw error
  }
}
```

```tsx
// React component
function CreateUser({ errors }: { errors?: Record<string, string> }) {
  return (
    <form>
      <input name="email" />
      {errors?.email && <span className="error">{errors.email}</span>}

      <input name="password" type="password" />
      {errors?.password && <span className="error">{errors.password}</span>}
    </form>
  )
}
```

## Type-Safe Request Parsing

For complete type safety, combine with request parsing:

```ts
import { parseRequestPayload, validateRequest, getValidatedData } from '@guren/server'

const schema = z.object({
  title: z.string(),
  content: z.string(),
})

Route.post('/posts', async (ctx) => {
  const data = getValidatedData<z.infer<typeof schema>>(ctx)!
  // Fully typed, validated data ready to use
  return ctx.json({ post: await Post.create(data) })
}, validateRequest(schema))
```

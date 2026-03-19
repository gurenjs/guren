# Validation

Guren provides a flexible validation system with two approaches: middleware-based validation with schema libraries (Zod, Valibot) and Laravel-style FormRequest classes for typed, reusable validation with authorization.

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

## Controller Validation Helpers

The simplest way to validate in controllers is with `validateBody`, `validateQuery`, and `validateParams`. They accept any Zod-like schema (anything with `safeParse()`) and throw `ValidationException` (422) on failure:

```ts
import { Controller } from '@guren/server'
import { z } from 'zod'

const StorePostSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(10),
})

const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

export default class PostsController extends Controller {
  async index() {
    const { page } = this.validateQuery(PageQuerySchema)
    const posts = await Post.paginate({ page })
    return this.json(posts)
  }

  async show() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    return this.json(post)
  }

  async store() {
    const data = await this.validateBody(StorePostSchema)
    const post = await Post.create(data)
    return this.created({ post })
  }
}
```

| Helper | Input Source | Async | Description |
|--------|-------------|-------|-------------|
| `this.validateBody(schema)` | Request body | Yes | Parses JSON or form body |
| `this.validateQuery(schema)` | Query string | No | Parses `?page=1&sort=desc` |
| `this.validateParams(schema)` | Route params | No | Parses `:id`, `:slug`, etc. |

> [!TIP]
> These helpers work with any schema library that implements `safeParse()` — Zod, Valibot, or custom validators.

## FormRequest Classes

FormRequest classes combine validation rules, authorization logic, and type safety in a single reusable class. Use this when you need authorization logic or Laravel-style rule definitions.

### Defining a FormRequest

```ts
// app/Http/Requests/StorePostRequest.ts
import { FormRequest, required, stringRule, min, max } from '@guren/server'

interface StorePostData {
  title: string
  content: string
  status: string
}

export class StorePostRequest extends FormRequest<StorePostData> {
  rules() {
    return {
      title: [required(), stringRule(), min(3), max(200)],
      content: [required(), stringRule(), min(10)],
      status: [required(), stringRule()],
    }
  }

  authorize(): boolean {
    // Return true to allow the request, false to reject with 403
    return this.user() !== null
  }
}
```

### Using FormRequest in Controllers

Pass the FormRequest class to `this.validate()` in your controller:

```ts
import { Controller } from '@guren/server'
import { StorePostRequest } from '@/app/Http/Requests/StorePostRequest'
import { UpdatePostRequest } from '@/app/Http/Requests/UpdatePostRequest'
import { Post } from '@/app/Models/Post'

export default class PostsController extends Controller {
  async store() {
    // Validates and returns typed data, or returns 422 automatically
    const data = await this.validate(StorePostRequest)

    const post = await Post.create(data)
    return this.created({ post })
  }

  async update() {
    const data = await this.validate(UpdatePostRequest)
    const id = this.ctx.req.param('id')

    await Post.update(Number(id), data)
    return this.redirect(`/posts/${id}`)
  }
}
```

If validation fails, a 422 response is returned automatically with structured error details. If `authorize()` returns `false`, a 403 Forbidden response is returned.

### Available Validation Rules

```ts
import {
  required,
  stringRule,
  numberRule,
  booleanRule,
  min,
  max,
  email,
  url,
  regex,
  confirmed,
  unique,
  exists,
  inArray,
  date,
  before,
  after,
  nullable,
  arrayRule,
  minLength,
  maxLength,
} from '@guren/server'
```

#### Rule Examples

```ts
class CreateUserRequest extends FormRequest<CreateUserData> {
  rules() {
    return {
      name: [required(), stringRule(), min(2), max(100)],
      email: [required(), email(), unique('users', 'email')],
      password: [required(), stringRule(), min(8), confirmed()],
      age: [nullable(), numberRule(), min(13)],
      role: [required(), inArray(['user', 'admin', 'moderator'])],
      website: [nullable(), url()],
      bio: [nullable(), stringRule(), maxLength(500)],
      tags: [nullable(), arrayRule(), minLength(1), maxLength(10)],
      birthDate: [nullable(), date(), before(new Date())],
    }
  }
}
```

### Custom Validation Messages

Override `messages()` to provide custom error messages:

```ts
class StorePostRequest extends FormRequest<StorePostData> {
  rules() {
    return {
      title: [required(), stringRule(), min(3)],
      content: [required(), stringRule()],
    }
  }

  messages() {
    return {
      'title.required': 'Every post needs a title.',
      'title.min': 'The title must be at least 3 characters.',
      'content.required': 'Please write some content for your post.',
    }
  }
}
```

### Accessing Request Data in FormRequest

FormRequest classes have access to the current request context:

```ts
class UpdatePostRequest extends FormRequest<UpdatePostData> {
  rules() {
    return {
      title: [required(), stringRule(), min(3)],
      // Use current route parameter in validation
      slug: [required(), stringRule(), unique('posts', 'slug', {
        ignore: this.param('id'),
      })],
    }
  }

  authorize(): boolean {
    // Check if the user owns this post
    const user = this.user()
    const postId = this.param('id')
    return user?.id === Number(postId)
  }
}
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

With FormRequest, validation errors are automatically shared with the Inertia page. For manual validation, pass errors to your frontend:

```ts
// Controller with FormRequest (recommended)
async store() {
  const data = await this.validate(StorePostRequest)
  // Validation errors are handled automatically - 422 response with errors
  await Post.create(data)
  return this.redirect('/posts')
}
```

```ts
// Controller with manual validation
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

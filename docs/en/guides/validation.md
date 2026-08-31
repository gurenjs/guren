# Validation

Guren's primary validation path is schema-first. Use Zod-compatible schemas in controllers, route definitions, or middleware so request parsing and type inference stay in one place. A legacy `FormRequest` compatibility layer still exists for migrations.

> **Supported Zod version:** the zod 4 API only. Runtime validation duck-types any schema with `safeParse`, but the tools that read schemas structurally — `guren codegen`, OpenAPI generation, `guren context` — refuse schemas authored with the zod v3 API (the old `zod@3` package or the `zod/v3` subpath) and say so with a warning. Author schemas with `import { z } from 'zod'`.

## Quick Start

Use controller validation helpers for the mainline path:

```ts
import { Controller, paginate } from '@guren/core'
import { z } from 'zod'
import { Post } from '@/app/Models/Post'
import { PostResource } from '@/app/Http/Resources/PostResource'
import { pages } from '@/.guren/pages.gen'

const StorePostSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(10),
})

const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

export default class PostsController extends Controller {
  async index() {
    const { page } = this.validateQuery(PageQuerySchema)
    const result = await Post.paginate({ page, perPage: 10 })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })

    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    })
  }

  async store() {
    const data = await this.validateBody(StorePostSchema)
    const post = await Post.create(data)
    return this.created({ post: new PostResource(post).toJSON() })
  }
}
```

## Controller Validation Helpers

The simplest way to validate in controllers is with `validateBody`, `validateQuery`, and `validateParams`. They accept any Zod-like schema (anything with `safeParse()`) and throw `ValidationException` (422) on failure:

```ts
import { Controller } from '@guren/core'
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

### Array-Style Query Parameters

Repeated query keys reach your schema as arrays: `?tag=a&tag=b` becomes `{ tag: ['a', 'b'] }`. A key that appears only once stays a plain string, so use `union` when a parameter may appear one or more times:

```ts
const FilterQuerySchema = z.object({
  // ?tag=a&tag=b -> ['a', 'b'] / ?tag=a -> 'a'
  tag: z.union([z.string(), z.array(z.string())]).optional()
    .transform((value) => (typeof value === 'string' ? [value] : value ?? [])),
})
```

This applies to `this.validateQuery()` and to `query:` schemas attached via [route contracts](./routing.md#route-contracts).

## Middleware Validation

### `validateRequest(schema)` Compatibility Middleware

Factory that creates validation middleware:

```ts
import { Router, validateRequest } from '@guren/core'
import { z } from 'zod'

const schema = z.object({
  email: z.email(),
  password: z.string().min(8),
})

const router = new Router()

router.post('/login', [AuthController, 'login'], validateRequest(schema))
```

By default, validation errors return a 422 response with error details.

### `validateRequestWith(schemaFactory)`

For dynamic schemas based on request context:

```ts
import { Router, validateRequestWith } from '@guren/core'

const router = new Router()

router.put('/users/:id', [UserController, 'update'], validateRequestWith((ctx) => {
  const isAdmin = ctx.get('user')?.role === 'admin'

  return z.object({
    name: z.string().min(1),
    email: z.email(),
    // Only admins can change roles
    role: isAdmin ? z.enum(['user', 'admin']) : z.never().optional(),
  })
}))
```

## Getting Validated Data

After validation middleware runs, retrieve typed data with `getValidatedData()`:

```ts
import { getValidatedData } from '@guren/core'
import type { z } from 'zod'
import { Router } from '@guren/core'

const router = new Router()

router.post('/posts', async (ctx) => {
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
import { validate, validateSafe } from '@guren/core'

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
import { Router } from '@guren/core'

const schema = v.object({
  name: v.string([v.minLength(1)]),
  email: v.string([v.email()]),
})

const router = new Router()

router.post('/users', handler, validateRequest(schema))
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
  email: z.email().toLowerCase(),
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

### Automatic Handling on Inertia Requests

When a `ValidationException` is thrown during an Inertia request (one carrying the `X-Inertia` header), Guren does not return the JSON payload above. Instead it behaves like Laravel: the errors are flashed to the session and the request is redirected back (`303`) to the previous page. On the next page load the flashed errors are injected into the shared `errors` prop, flattened to one message per field:

```tsx
function Login({ errors }: { errors?: Record<string, string> }) {
  return (
    <form>
      <input name="email" />
      {errors?.email && <span className="error">{errors.email}</span>}
    </form>
  )
}
```

This applies to `validateBody` / `validateQuery` / `validateParams` failures as well as `ValidationException.withMessages(...)` thrown from your own code. Flashing requires session middleware, which is mounted automatically when the `auth` option is set. To customize the behavior, register your own renderer for `ValidationException` in a service provider — it takes precedence over the built-in one.

### Displaying in Inertia

Use page definitions with `ValidationErrors<T>` so controller and component share the same error shape.

```ts
import { type ValidationErrors } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

type CreateUserFields = 'email' | 'password'
type CreateUserProps = {
  errors?: ValidationErrors<CreateUserFields>
}

async store() {
  const result = await this.validateBodySafe(schema)
  if (!result.success) {
    return this.inertia<CreateUserProps>(pages.users.Create, {
      errors: result.errors,
    })
  }

  await User.create(result.data)
  return this.redirect('/users')
}
```

```tsx
import type { PageProps } from '@guren/inertia-client'
import { pages } from '@/.guren/pages.gen'

type Props = PageProps<typeof pages.users.Create>

function CreateUser({ errors }: Props) {
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
import { Router, parseRequestPayload, validateRequest, getValidatedData } from '@guren/core'

const schema = z.object({
  title: z.string(),
  content: z.string(),
})

const router = new Router()

router.post('/posts', async (ctx) => {
  const data = getValidatedData<z.infer<typeof schema>>(ctx)!
  // Fully typed, validated data ready to use
  return ctx.json({ post: await Post.create(data) })
}, validateRequest(schema))
```

## Compiled Parsing (zod 4.5+)

zod 4.5 can compile schemas into a generated fast path. Apps scaffolded with `create-guren-app` enable it out of the box: the first import in `src/app.ts` is

```ts
import 'zod/compile'
```

Every schema built after that import parses through the compiled path automatically. Because Guren's validation helpers, route contracts (`params`, `query`, `body`, `output`), and validation middleware all call your schema's own `parse`/`safeParse`, they speed up without any further changes.

To adopt it in an existing app, move your `zod` dependency to `^4.5.0` and add the import as the **first** line of your entry module, before any module that defines schemas.

In our benchmarks on Bun, validating a 100-item list output dropped from about 19µs to 1.2µs, and a five-field body parsed about four times faster. End to end, an API endpoint returning a validated 100-item list served roughly 10% more requests per second at a lower median latency. Your numbers will scale with how much of a route's time is spent validating.

Three things to know:

- **Import order matters.** Schemas built before the import keep the regular parser. Keep the import first in the entry module.
- **Restricted runtimes are handled.** Call `z.config({ jitless: true })` if your runtime forbids generated code (strict CSP); compilation is skipped and everything still works. Unsupported schema features silently keep the regular parser too — compilation never throws.
- **Keep refinements side-effect free.** On invalid input, `.refine()` and `.transform()` callbacks can run twice (the fast path first, then the fallback that builds the full error). Validation results are unchanged, but side effects inside those callbacks would double.

Schema-agnostic validation is unaffected: Valibot or custom validators simply keep their own `parse`/`safeParse` behavior.

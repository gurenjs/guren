# Validation

Validate request input against a schema and get typed, parsed values back. When the input is invalid, the request ends with a 422 response, or, on an Inertia request, a redirect back to the form with one error message per field.

Write schemas with zod 4 (`import { z } from 'zod'`). [Schema Interface](#schema-interface) covers other libraries.

## Choosing Where to Validate

| Where | Use it when | Read the values with |
|-------|-------------|----------------------|
| [Controller helpers](#controller-validation-helpers) | The default, inside a controller action | The return value of `this.validateBody()` and its siblings |
| [Route contract](#route-contract-validation) | The route should also carry its types into codegen, OpenAPI and agent tools | `this.validated('route.name')` |
| [Middleware](#middleware-validation) | The handler is an inline function, or the schema depends on the request | `getValidatedData(ctx)` |
| [`validate()` / `validateSafe()`](#manual-validation) | The data does not come from a request: a job, a console command, a script | The return value |

A `FormRequest` class layer also exists for code migrated from Laravel. It is deprecated; write new validation with one of the four above.

## Quick Start

Call a helper at the top of the action. It returns the parsed value, so `data` below is typed `{ title: string; content: string }`:

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

If the body fails `StorePostSchema`, `validateBody()` throws a `ValidationException` and the action stops there. You do not catch it: the framework turns it into the response described in [Form Validation Errors](#form-validation-errors).

## Controller Validation Helpers

Each helper reads one part of the request:

| Helper | Input source | Async | On failure |
|--------|--------------|-------|------------|
| `this.validateBody(schema)` | JSON or form body | Yes | Throws `ValidationException` (422) |
| `this.validateQuery(schema)` | Query string (`?page=1&sort=desc`) | No | Throws `ValidationException` (422) |
| `this.validateParams(schema)` | Route parameters (`:id`, `:slug`) | No | Throws `ValidationException` (422) |
| `this.validateBodySafe(schema)` | JSON or form body | Yes | Returns `{ success: false, errors }` |
| `this.validateQuerySafe(schema)` | Query string | No | Returns `{ success: false, errors }` |
| `this.validateParamsSafe(schema)` | Route parameters | No | Returns `{ success: false, errors }` |

Use a `Safe` variant when the action decides what to do with the errors itself, as in [Displaying in Inertia](#displaying-in-inertia). On success it returns `{ success: true, data }`.

Route parameters arrive as strings, so coerce them in the schema:

```ts
const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export default class PostsController extends Controller {
  async show() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    return this.json(post)
  }
}
```

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

## Route Contract Validation

A route that declares `params`, `query` or `body` schemas is validated before its handler runs, controller actions included. The action then reads the parsed values with `this.validated()` instead of naming the schema a second time:

```ts
router.post('/posts', { name: 'posts.store', body: StorePostSchema }, [PostsController, 'store'])

export default class PostsController extends Controller {
  async store() {
    const { body } = this.validated('posts.store')
    const post = await Post.create(body)
    return this.created({ post })
  }
}
```

On a controller action, a failure throws the same `ValidationException` (422) as the helpers, so Inertia forms display it unchanged. A route whose handler is an inline function answers the 422 itself, in the middleware's shape (see [Form Validation Errors](#form-validation-errors)). See [Reading Validated Input](./routing.md#reading-validated-input).

## Middleware Validation

### `validateRequest(schema)`

`validateRequest()` builds a middleware that validates the request body before the handler runs. The handler reads the parsed body with `getValidatedData()`:

```ts
import { Router, getValidatedData, validateRequest } from '@guren/core'
import { z } from 'zod'

const CreatePostSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
})

const router = new Router()

router.post('/posts', async (ctx) => {
  const data = getValidatedData<z.infer<typeof CreatePostSchema>>(ctx)!
  return ctx.json({ post: await Post.create(data) })
}, validateRequest(CreatePostSchema))
```

`getValidatedData()` returns `undefined` when the middleware has not run on the route, hence the `!`.

On failure the middleware answers by itself, with a 422 holding the first message for each top-level field:

```json
{
  "errors": {
    "title": "Too small: expected string to have >=1 characters"
  }
}
```

### `validateRequestWith(schemaFactory)`

Use it when the schema depends on the request. The factory runs synchronously, so it cannot await the signed-in user; resolve what it needs in a middleware mounted before it, as `resolveIsAdmin` does here:

```ts
import { AUTH_CONTEXT_KEY, Router, defineMiddleware, validateRequestWith } from '@guren/core'
import type { AuthContext } from '@guren/core'

const resolveIsAdmin = defineMiddleware(async (ctx, next) => {
  const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
  const user = await auth?.user<{ role: string }>()
  ctx.set('isAdmin', user?.role === 'admin')
  await next()
})

const router = new Router()

router.put('/users/:id', [UserController, 'update'], resolveIsAdmin, validateRequestWith((ctx) => {
  const isAdmin = ctx.get('isAdmin') === true

  return z.object({
    name: z.string().min(1),
    email: z.email(),
    // Only admins can change roles
    role: isAdmin ? z.enum(['user', 'admin']) : z.never().optional(),
  })
}))
```

The action reads the parsed body with `getValidatedData(this.ctx)`.

### Custom Error Handling

Both middleware take an `onError` option that replaces the 422 response. It receives the same field-to-message map:

```ts
validateRequest(schema, {
  onError: (ctx, errors) => {
    return ctx.json({
      message: 'Validation failed',
      errors: Object.entries(errors).map(([field, message]) => ({ field, message })),
    }, 422)
  },
})
```

`status` changes the failure status instead, and `fallbackMessage` sets the message used when no error names a field.

## Manual Validation

For data that does not come from a request, call `validate()` or `validateSafe()`:

```ts
import { validate, validateSafe } from '@guren/core'

// Returns the parsed data, or throws the schema's own error (a ZodError for zod)
const data = validate(schema, input)

// Never throws
const result = validateSafe(schema, input)
if (result.success) {
  console.log(result.data)
} else {
  console.log(result.errors) // { field: 'first message' }
}
```

## Form Validation Errors

Each path reports errors in its own shape. "Nested key" is how a failure on `address.postalCode` is keyed:

| Source | Shape | Messages per key | Nested key |
|--------|-------|------------------|------------|
| Helpers and contract `body`, JSON request | `{ message, errors: { [key]: string[] } }`, 422 | All | `address.postalCode` |
| Contract `params` / `query`, JSON request | `{ message, errors: { [key]: string[] } }`, 422 | One | `address` |
| Any `ValidationException`, Inertia request | The page's `errors` prop: `{ [key]: string }` | One | As thrown |
| `this.validateBodySafe()` and siblings | `{ success: false, errors: { [key]: string } }` | One | `address.postalCode` |
| `validateRequest()`, `validateSafe()`, inline-handler contracts | `{ errors: { [key]: string } }` | One | `address` |

A key of `address` is used whenever the key is the top-level field; an error that names no field there is keyed `message`.

### JSON Requests

A JSON or API request that throws `ValidationException` gets a 422:

```json
{
  "message": "The given data was invalid.",
  "errors": {
    "email": ["Invalid email address"],
    "password": ["Too small: expected string to have >=8 characters"]
  }
}
```

### Automatic Handling on Inertia Requests

An Inertia request (one carrying the `X-Inertia` header) gets no JSON. Instead:

1. The errors are stored for the next request only.
2. The response is a `303` redirect back to the previous page.
3. On that page load, the errors arrive in the shared `errors` prop, one message per field.

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

This covers failures from `validateBody`, `validateQuery`, `validateParams` and route contracts, and any `ValidationException.withMessages(...)` you throw yourself.

A few details:

- The errors are stored in the session when the app has one (`createApp({ auth })` mounts it), and otherwise in a short-lived cookie, so a fresh scaffold shows them too.
- The redirect goes to the `Referer` header, or to `/` when there is none.
- To replace this behavior, register your own renderer from a service provider's `boot()`: `this.container.make<ExceptionHandler>('exception.handler').render(ValidationException, (error, ctx) => …)`. It runs before the built-in one.

### Displaying in Inertia

To render the errors on the same response instead of redirecting, use a `Safe` helper and pass its `errors` to the page. Declare the page's `errors` prop with `ValidationErrors<T>`; codegen reads the page's `Props`, so `this.inertia()` checks the controller against it:

```ts
import { pages } from '@/.guren/pages.gen'

async store() {
  const result = await this.validateBodySafe(schema)
  if (!result.success) {
    return this.inertia(pages.users.Create, {
      errors: result.errors,
    })
  }

  await User.create(result.data)
  return this.redirect('/users')
}
```

```tsx
import type { ValidationErrors } from '@guren/core'

interface Props {
  errors?: ValidationErrors<'email' | 'password'>
}

export default function CreateUser({ errors }: Props) {
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

## Schema Interface

Validation calls the schema's own methods rather than importing Zod, so any object with this shape works. `validate()` needs only `parse()`; everything else needs only `safeParse()`:

```ts
interface ValidationSchema<T> {
  parse(data: unknown): T
  safeParse(data: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }
}
```

The error keys come from `issues[].path`, so a schema from another library needs a small adapter that returns this shape.

The tools that read schemas structurally (`guren codegen`, which writes the typed route manifests; OpenAPI generation; `guren context`) understand zod 4 only. They skip a schema written with the zod v3 API (the `zod@3` package or the `zod/v3` subpath) and print a warning.

## Compiled Parsing (zod 4.5+)

zod 4.5 can compile schemas into a generated fast path. Apps scaffolded with `create-guren-app` enable it out of the box: the first import in `src/app.ts` is

```ts
import 'zod/compile'
```

Every schema built after that import parses through the compiled path. Guren's validation helpers, route contracts (`params`, `query`, `body`, `output`) and validation middleware all call your schema's own `parse`/`safeParse`, so they speed up with no further changes.

To adopt it in an existing app, move your `zod` dependency to `^4.5.0` and add the import as the **first** line of your entry module, before any module that defines schemas.

In our benchmarks on Bun, validating a 100-item list output dropped from about 19µs to 1.2µs, and a five-field body parsed about four times faster. End to end, an API endpoint returning a validated 100-item list served roughly 10% more requests per second at a lower median latency. Your numbers will scale with how much of a route's time is spent validating.

Three things to know:

- **Import order matters.** Schemas built before the import keep the regular parser. Keep the import first in the entry module.
- **Restricted runtimes are handled.** If your runtime forbids generated code (a strict CSP), call `z.config({ jitless: true })`; compilation is skipped and everything still works. Schema features the compiler does not support also fall back to the regular parser, so compilation never throws.
- **Keep refinements side-effect free.** On invalid input, `.refine()` and `.transform()` callbacks can run twice: the fast path runs first, then the fallback that builds the full error. Validation results are unchanged, but side effects inside those callbacks would happen twice.

Schemas from other libraries are unaffected; they keep their own `parse`/`safeParse`.

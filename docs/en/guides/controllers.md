# Controllers

Controllers are where your application logic lives. They receive HTTP requests, interact with models and services, and return responses. Think of them as the glue between what the user asks for and what your app delivers.

## Your First Controller

Generate a controller with the CLI, then add a couple of methods:

```bash
bunx guren make:controller PostsController
```

```ts
// app/Http/Controllers/PostsController.ts
import { Controller } from '@guren/server'
import { Post } from '@/app/Models/Post'

export default class PostsController extends Controller {
  async index() {
    const posts = await Post.all()
    return this.inertia('posts/Index', { posts })
  }

  async show() {
    const post = await Post.findOrFail(this.ctx.req.param('id'))
    return this.inertia('posts/Show', { post })
  }
}
```

Wire it up in `routes/web.ts`:

```ts
import PostsController from '@/app/Http/Controllers/PostsController'

Route.get('/posts', [PostsController, 'index'])
Route.get('/posts/:id', [PostsController, 'show'])
```

That is all it takes. The `[Controller, 'method']` tuple tells Guren which class to instantiate and which method to call for each request.

## Responding to Requests

Controllers provide helpers for every common response type:

```ts
export default class PostsController extends Controller {
  async index() {
    const posts = await Post.all()
    return this.json(posts)              // 200 JSON
  }

  async show() {
    const post = await Post.findOrFail(this.ctx.req.param('id'))
    return this.inertia('posts/Show', { post })  // Inertia page
  }

  async store() {
    const post = await Post.create({ title: 'New' })
    return this.created({ post })        // 201 JSON
  }

  async update() {
    await Post.update({ id: 1 }, { title: 'Updated' })
    return this.redirect('/posts')       // 302 redirect
  }

  async destroy() {
    await Post.delete({ id: 1 })
    return this.noContent()              // 204 empty
  }
}
```

| Helper | Status | Description |
|--------|--------|-------------|
| `this.json(data)` | 200 | Return JSON |
| `this.inertia(component, props)` | 200 | Render an Inertia page |
| `this.created(data)` | 201 | JSON with 201 status |
| `this.accepted(data)` | 202 | JSON with 202 status |
| `this.redirect(url)` | 302 | HTTP redirect |
| `this.noContent()` | 204 | Empty response |

## Reading Input

Controllers parse both JSON and form-encoded bodies automatically:

```ts
async store() {
  // Read a single field
  const title = await this.input('title')

  // Query parameters (synchronous)
  const page = this.query('page', '1')

  // Pick specific fields from the body
  const data = await this.only('title', 'content', 'status')

  // Everything except certain fields
  const safe = await this.except('_token', '_method')

  // Check if a field exists
  if (await this.has('email')) {
    // ...
  }
}
```

> [!TIP]
> Body-reading methods (`input`, `only`, `except`, `has`) are `async` because they parse the request body. The `query` method reads URL parameters and is synchronous.

## Validation

### Zod Schema Helpers (Recommended)

The simplest approach is to use `validateBody`, `validateQuery`, and `validateParams` with Zod schemas directly in your controller. They accept any object with a `safeParse()` method (Zod, Valibot, etc.) and throw a `ValidationException` (422) on failure:

```ts
import { Controller } from '@guren/server'
import { z } from 'zod'
import { Post } from '@/app/Models/Post'

const PostIdParamSchema = z.object({ id: z.coerce.number().int().positive() })
const StorePostSchema = z.object({ title: z.string().min(1), content: z.string().min(10) })
const PageQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1) })

export default class PostsController extends Controller {
  async index() {
    const { page } = this.validateQuery(PageQuerySchema)   // throws 422
    const posts = await Post.paginate({ page })
    return this.inertia('posts/Index', { posts })
  }

  async show() {
    const { id } = this.validateParams(PostIdParamSchema)   // throws 422
    const post = await Post.findOrFail(id)                   // throws 404
    return this.inertia('posts/Show', { post })
  }

  async store() {
    const data = await this.validateBody(StorePostSchema)    // throws 422
    const user = await this.auth.userOrFail()                // throws 401
    const post = await Post.create({ ...data, authorId: user.id })
    return this.redirect('/posts')
  }
}
```

| Helper | Input Source | Async |
|--------|-------------|-------|
| `this.validateBody(schema)` | Request body (JSON / form) | Yes |
| `this.validateQuery(schema)` | URL query parameters | No |
| `this.validateParams(schema)` | Route parameters (`:id`, etc.) | No |

All three throw `ValidationException` (HTTP 422) on failure, which the `ExceptionHandler` renders automatically.

### FormRequest Classes

For more complex scenarios requiring authorization logic, use FormRequest classes:

```ts
// app/Http/Requests/StorePostRequest.ts
import { FormRequest } from '@guren/server'
import { required, stringRule, min, max, inValues } from '@guren/server'

interface StorePostData {
  title: string
  content: string
  status: 'draft' | 'published'
}

export class StorePostRequest extends FormRequest<StorePostData> {
  rules() {
    return {
      title: [required(), stringRule(), min(3), max(255)],
      content: [required(), stringRule()],
      status: [required(), inValues(['draft', 'published'])],
    }
  }

  authorize() {
    return this.user() !== null
  }
}
```

Use it in the controller with one line:

```ts
async store() {
  const data = await this.validate(StorePostRequest)
  // `data` is typed as StorePostData — no manual parsing needed
  const post = await Post.create(data)
  return this.redirect('/posts')
}
```

If validation fails, a 422 response is returned automatically. If `authorize()` returns `false`, a 403 is returned.

> [!NOTE]
> See the [Validation Guide](./validation.md) for the full list of built-in rules.

## Dependency Injection

When your controller needs services (caching, events, mail), declare them with `static inject` and Guren resolves them from the container:

```ts
import { Controller } from '@guren/server'
import type { CacheManager, EventManager } from '@guren/server'
import { Post } from '@/app/Models/Post'

export default class PostsController extends Controller {
  static inject = ['cache', 'events'] as const

  constructor(
    private cache: CacheManager,
    private events: EventManager,
  ) {
    super()
  }

  async index() {
    const cached = await this.cache.get('posts:all')
    if (cached) return this.json(cached)

    const posts = await Post.all()
    await this.cache.put('posts:all', posts, 300)
    return this.json(posts)
  }
}
```

The `as const` assertion on `inject` ensures type safety. Each string maps to a key registered in the service container.

## Resource Controllers

Instead of defining seven routes by hand, use `Route.resource()`:

```ts
Route.resource('/posts', PostsController)
```

This generates:

| Method | Path | Controller Method |
|--------|------|-------------------|
| GET | `/posts` | `index` |
| GET | `/posts/create` | `create` |
| POST | `/posts` | `store` |
| GET | `/posts/:id` | `show` |
| GET | `/posts/:id/edit` | `edit` |
| PUT | `/posts/:id` | `update` |
| DELETE | `/posts/:id` | `destroy` |

Only methods that exist on your controller are registered. Limit the routes with `only` or `except`:

```ts
Route.resource('/posts', PostsController, { only: ['index', 'show'] })
```

## Testing Controllers

`TestApp` boots a lightweight instance of your app for expressive HTTP testing:

```ts
import { TestApp } from '@guren/testing'

const app = await TestApp.create()

// Basic request assertions
await app.get('/posts').assertOk()
await app.post('/posts', { title: 'New' }).assertStatus(201)

// Authenticated requests
await app.actingAs(user).get('/dashboard').assertOk()

// JSON structure assertions
await app.get('/api/posts')
  .assertOk()
  .assertJsonCount(5, 'data')
  .assertJsonPath('data.0.title', 'Hello')
```

> [!TIP]
> Controllers stay thin when they delegate business logic to models or services. Treat them as an orchestration layer that glues your app together.

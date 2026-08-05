# Controllers

Controllers are where your application logic lives. They receive HTTP requests, interact with models and services, and return responses. Think of them as the glue between what the user asks for and what your app delivers.

## Your First Controller

Generate a controller with the CLI, then add a couple of methods:

```bash
bunx guren make:controller PostsController
```

```ts
// app/Http/Controllers/PostsController.ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { Post } from '@/app/Models/Post'
import { PostResource, type PostResourceData } from '@/app/Http/Resources/PostResource'
import { ListPostsQuerySchema, PostIdParamSchema } from '@/app/Http/Validators/PostValidator'
import { pages } from '@/.guren/pages.gen'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

export default class PostsController extends Controller {
  async index() {
    const { page } = this.validateQuery(ListPostsQuerySchema)
    const result = await Post.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })

    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies PostsIndexProps)
  }

  async show() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
  }
}
```

Wire it up in `routes/web.ts`:

```ts
import { Router } from '@guren/core'
import PostsController from '@/app/Http/Controllers/PostsController'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostsController, 'index'])
  router.get('/posts/:id', [PostsController, 'show'])
}
```

That is all it takes. The `[Controller, 'method']` tuple tells Guren which class to instantiate and which method to call for each request.

## Responding to Requests

Controllers provide helpers for every common response type:

```ts
export default class PostsController extends Controller {
  async index() {
    const posts = await Post.all()
    return this.json(posts) // 200 JSON
  }

  async show() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() }) // Inertia page
  }

  async store() {
    const data = await this.validateBody(StorePostSchema)
    const post = await Post.create(data)
    return this.created({ post: new PostResource(post).toJSON() }) // 201 JSON
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

  // Canonical schema-first body parsing
  const data = await this.validateBody(StorePostSchema)

  // Check if a field exists
  if (await this.has('email')) {
    // ...
  }
}
```

> [!TIP]
> Body-reading methods (`input`, `has`, `validateBody`) are `async` because they parse the request body. The `query` method reads URL parameters and is synchronous.

## Validation

### Zod Schema Helpers (Recommended)

The simplest approach is to use `validateBody`, `validateQuery`, and `validateParams` with Zod schemas directly in your controller. They accept any object with a `safeParse()` method (Zod, Valibot, etc.) and throw a `ValidationException` (422) on failure:

```ts
import { Controller } from '@guren/core'
import { z } from 'zod'
import { Post } from '@/app/Models/Post'

const PostIdParamSchema = z.object({ id: z.coerce.number().int().positive() })
const StorePostSchema = z.object({ title: z.string().min(1), content: z.string().min(10) })
const PageQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1) })

export default class PostsController extends Controller {
  async index() {
    const { page } = this.validateQuery(PageQuerySchema) // throws 422
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

  async show() {
    const { id } = this.validateParams(PostIdParamSchema) // throws 422
    const post = await Post.findOrFail(id) // throws 404
    return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
  }

  async store() {
    const data = await this.validateBody(StorePostSchema) // throws 422
    const user = await this.auth.userOrFail() // throws 401
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

## Dependency Injection

When your controller needs services (caching, events, mail), declare them with `static inject` and Guren resolves them from the container:

```ts
import { Controller } from '@guren/core'
import type { CacheManager, EventManager } from '@guren/core'
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

Instead of defining seven routes by hand, use `router.resource()`:

```ts
router.resource('/posts', PostsController)
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
router.resource('/posts', PostsController, { only: ['index', 'show'] })
```

## Sharing Data Between Methods

Controllers are instantiated per request, so one method can set an instance field for a helper method to reuse. For data every page needs (the signed-in user, for example), reach for Inertia shared props or middleware instead.

## Inertia Shared Props

Use `shareInertiaProps()` to inject application-wide data into every Inertia response. The natural home for the call is a service provider's `boot()` (generate one with `bunx guren make:provider`).

```ts
// app/Providers/LocaleProvider.ts
import { ServiceProvider, shareInertiaProps } from '@guren/core'

export default class LocaleProvider extends ServiceProvider {
  boot(): void {
    shareInertiaProps((ctx) => ({
      i18n: { locale: ctx.req.header('accept-language')?.split(',')[0] ?? 'en' },
    }))
  }
}
```

It merges its props over whatever resolver was registered before, so several providers can each contribute shared props without clobbering one another.

> [!NOTE]
> Sharing the signed-in user (`auth.user`) is already registered for you by the `AuthProvider` that `bunx guren add auth` generates — there's no need to register it again. See the [Authentication guide](./authentication.md) for details.

Augment the exported `InertiaSharedProps` interface to keep these props typed across controllers and React pages:

```ts
// types/inertia.d.ts
import type { UserRecord } from '@/app/Models/User'

declare module '@guren/core' {
  interface InertiaSharedProps {
    auth: { user: UserRecord | null }
  }
}
```

When you need the component's prop type, `InferInertiaProps<ReturnType<Controller['action']>>` gives you both the action props and the shared props.

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

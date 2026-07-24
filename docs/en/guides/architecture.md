# Architecture

Guren reimagines Laravel's design principles in TypeScript, tying together Bun, Hono, Inertia.js, React, and Drizzle ORM into a full-stack MVC framework. This document outlines the end-to-end flow from routing to response generation and explains the main building blocks.

## High-Level Flow
1. **Container & Providers**: `ServiceProvider` classes register services into the IoC container during boot.
2. **Routing**: Define routes in `routes/web.ts` with a registrar that receives an app-local `Router`.
3. **Controllers**: Extend the `Controller` base class with dependency injection via `static inject`.
4. **Models**: Extend `Model<TRecord>` and link to a Drizzle schema via `static table`.
5. **Views**: Render React components (`resources/js/pages/`) through Inertia.js.
6. **Application boot**: `Application` initialises the container, runs providers, mounts routes, and starts the Bun/Hono server.

## Project Layout
- `app/Http/Controllers/`: Home for your controllers.
- `app/Http/Requests/`: Optional legacy `FormRequest` classes for compatibility-heavy apps.
- `app/Models/`: Drizzle-backed models extending `Model<T>`.
- `app/Providers/`: ServiceProvider classes for registering services.
- `app/Events/`: Event classes.
- `app/Listeners/`: Event listener classes.
- `app/Jobs/`: Queue job classes.
- `config/`: Application and database configuration files.
- `db/`: Schema definitions, migrations, and seeders.
- `resources/js/pages/`: React pages rendered via Inertia.
- `routes/`: Route declarations (`routes/web.ts`).
- `src/`: Application bootstrapping (`src/main.ts`, `src/app.ts`).

## Naming Conventions
- Files that export a single class or type (e.g. controllers, models, HTTP application) use `PascalCase.ts` so the filename mirrors the exported identifier.
- Utility modules that gather functions or helpers use `kebab-case.ts` (for example `dev-assets.ts`, `inertia-assets.ts`) to distinguish them from class-centric modules.
- Each directory sticks to one convention; when you add a new file under `app/Http/Controllers/` or `app/Models/`, prefer PascalCase for new classes, while helper-heavy folders should stay in kebab-case.

## Service Container

The IoC container is the heart of Guren's architecture. It manages service registration, resolution, and dependency injection throughout the application lifecycle.

### Binding Services

```ts
import { ServiceProvider } from '@guren/core'
import { CacheManager } from '@guren/core'

export default class CacheProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('cache', () => {
      return new CacheManager({ driver: 'memory' })
    })
  }

  boot(): void {
    // Runs after all providers have registered
    const cache = this.container.make<CacheManager>('cache')
    cache.initialize()
  }
}
```

### Resolving Services

```ts
// Type-safe resolution
const events = container.make<EventManager>('events')
const cache = container.make<CacheManager>('cache')

// Testing: replace a service with a fake
container.fake('events', mockEventManager)
```

### Facades

Facades provide a static proxy to services resolved from the container. They offer a convenient, expressive syntax without sacrificing testability:

```ts
import { createFacades } from '@guren/core'

const { Cache, Events } = createFacades(app.container)

// Use anywhere without manually resolving from the container
await Cache.get('user:1')
await Cache.put('user:1', userData, 3600)

Events.dispatch(new UserRegistered(user))
```

## Service Providers

All providers extend `ServiceProvider` and implement `register()` and optionally `boot()`:

```ts
import { ServiceProvider } from '@guren/core'

export default class AppServiceProvider extends ServiceProvider {
  register(): void {
    // Bind services into the container
    this.container.singleton('myService', () => new MyService())
  }

  boot(): void {
    // Runs after ALL providers have called register()
    // Safe to resolve other services here
    const db = this.container.make<Database>('db')
  }
}
```

- **`register()`**: Bind services into the container. Do not resolve other services here—they may not be registered yet.
- **`boot()`**: Called after every provider's `register()` has run. Safe to resolve and use other services.

> **Global middleware must be attached in `register()`.** Routes are mounted
> *between* `register()` and `boot()`, and Hono only applies middleware
> registered ahead of the matched route — `app.use()` from `boot()` never runs
> for your routes. Both hooks may be `async` if you need to load resources
> (e.g. translation files) first:
>
> ```ts
> export default class I18nProvider extends ServiceProvider {
>   async register(): Promise<void> {
>     const i18n = createI18n({ locale: 'ja', fallbackLocale: 'en', path: './lang' })
>     await i18n.loadLocales(['en', 'ja'])
>     setI18n(i18n)
>
>     const app = this.container.make<Application>('app')
>     app.use('*', localeMiddleware) // register(), not boot()
>   }
> }
> ```

## Routing
`routes/web.ts` exports a registrar and configures an app-local router:

```ts
import { Router, requireAuthenticated } from '@guren/core'
import PostController from '@/app/Http/Controllers/PostController'

export function registerWebRoutes(router: Router): void {
  router.aliasMiddleware('auth', requireAuthenticated())
  router.bind('post', Post)

  router.get('/', [PostController, 'index'])
  router.middleware('auth').group((auth) => {
    auth.get('/posts/:post', [PostController, 'show'])
  })
}
```

- Each `Application` owns its own router instance, so tests and multiple apps do not share route state.
- Controllers are referenced with the `[Class, 'method']` tuple.
- Route model binding automatically resolves model instances from route parameters.

## Controllers
Controllers extend `Controller` and support dependency injection via `static inject`. Methods return responses through helpers like `this.inertia()`, `this.json()`, `this.created()`, or `this.noContent()`.

```ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { PostResource, type PostResourceData } from '@/app/Http/Resources/PostResource'
import { pages } from '@/.guren/pages.gen'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

export default class PostController extends Controller {
  static inject = ['cache'] as const

  constructor(private cache: CacheManager) {
    super()
  }

  async index() {
    const result = await Post.where('status', 'published').paginate({ page: 1, perPage: 15 })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })

    return this.inertia<PostsIndexProps>(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: paginator,
    })
  }

  async store() {
    const data = await this.validateBody(StorePostSchema)
    const post = await Post.create(data)
    return this.created({ post })
  }
}
```

- `this.ctx`: Full Hono context.
- `this.request`: Convenience accessor for the underlying Request.
- `this.inertia(component, props, options)`: Creates an Inertia response.
- `this.validateBody(schema)`: Validates and returns typed request data.
- `await this.input('key')`, `this.query('key')`: Input helpers.

## Models and ORM
Models typically use `defineModel(table)` and connect to Drizzle via the table definition itself. The layer provides a fluent QueryBuilder, scopes, hooks, soft deletes, attribute casting, and mass assignment protection.

```ts
export type PostRecord = typeof posts.$inferSelect

export class Post extends defineModel(posts) {
  static fillable = ['title', 'content', 'status']
  static casts = { metadata: 'json', publishedAt: 'date' }

  static scopes = {
    published: (q: QueryBuilder<PostRecord>) => q.where('status', 'published'),
  }

  static hooks = {
    creating: async (data) => { data.slug = slugify(data.title) },
  }
}
```

- Provides Laravel-style helpers like `Model.all()`, `Model.find(id)`, `Model.findOrFail()`, `Model.first()`, and `Model.create(data)`.
- Fluent QueryBuilder: `Post.where('status', 'published').orderBy('createdAt', 'desc').limit(10).get()`.
- Table inference keeps static helpers strongly typed (e.g. `Post.find()` returns `PostRecord | null`).
- Use a provider such as `DatabaseProvider` (which calls `bootModels()`) to invoke `DrizzleAdapter.configure(db)`, making the adapter available to every model. When you need full control, use `Model.query(db)` or the Drizzle database instance directly.

## Inertia.js and Views
- Place React pages under `resources/js/pages/` and reference them by component name.
- The server embeds the Inertia payload inside HTML via the `data-page` attribute.
- The client loads React/Inertia from CDN ESM modules and hydrates the initial page.

## Bootstrapping the Application
`src/main.ts` in a generated project illustrates the boot process:

1. Export a route registrar from `routes/web.ts`.
2. Instantiate the application with providers and routes:
   ```ts
   const app = createApp({
     routes: registerWebRoutes,
     providers: [DatabaseProvider, AuthProvider, EventServiceProvider],
   })
   ```
3. `await app.boot()` to mount routes, run provider register/boot hooks, and prepare middleware.
4. `await app.listen()` to start the HTTP server.

This process runs under Bun as a native module and is triggered by `bun run dev`.

## Database Schema
- Drizzle schema definitions live in `db/schema.ts`.
- `config/database.ts` provisions tables when the container starts.
- Migrations are managed via `bunx guren make:migration` and applied with `bun run db:migrate`.

## Request Lifecycle
1. Hono receives an HTTP request.
2. Global middleware runs (session, CSRF, rate limiting, etc.).
3. The application router resolves the matching handler and runs route-level middleware.
4. Route model binding resolves any bound parameters.
5. The controller is instantiated with injected dependencies.
6. The controller method executes, using models to access the database.
7. `this.inertia()` hands data to the view and builds the Inertia response.
8. The client hydrates React on the first load; subsequent navigation stays within Inertia-powered SPA transitions.

For a deeper dive into internals, explore the [CLI Reference](./cli.md) and the inline documentation within your generated project.

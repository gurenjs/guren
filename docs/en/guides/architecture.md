# Architecture

Guren reimagines Laravel’s design principles in TypeScript, tying together Bun, Hono, Inertia.js, React, and Drizzle ORM into a full-stack MVC framework. This document outlines the end-to-end flow from routing to response generation and explains the main building blocks.

## High-Level Flow
1. **Routing**: Define routes in `routes/web.ts` using the `Route` DSL.
2. **Controllers**: Extend the `Controller` base class to access the Hono `Context`.
3. **Models**: Extend `Model<TRecord>` and link to a Drizzle schema via `static table`.
4. **Views**: Render React components (`resources/js/pages/`) through Inertia.js.
5. **Application boot**: `Application` initialises routes and models before starting the Bun/Hono server.

## Project Layout
- `app/Http/Controllers/`: Home for your controllers.
- `app/Models/`: Drizzle-backed models extending `Model<T>`.
- `config/`: Application and database configuration files.
- `db/`: Schema definitions, migrations, and seeders.
- `resources/js/pages/`: React pages rendered via Inertia.
- `routes/`: Route declarations (`routes/web.ts`).
- `src/`: Application bootstrapping (`src/main.ts`, `src/app.ts`).

## Naming Conventions
- Files that export a single class or type (e.g. controllers, models, HTTP application) use `PascalCase.ts` so the filename mirrors the exported identifier.
- Utility modules that gather functions or helpers use `kebab-case.ts` (for example `dev-assets.ts`, `inertia-assets.ts`) to distinguish them from class-centric modules.
- Each directory sticks to one convention; when you add a new file under `packages/server/src/http/`, prefer PascalCase for new classes, while helper-heavy folders such as the asset middleware or CLI utilities should stay in kebab-case.

## Routing
`routes/web.ts` uses a Laravel-like DSL:

```ts
import PostController from '@/Http/Controllers/PostController'

Route.get('/', [PostController, 'index'])
Route.group('/posts', () => {
  Route.get('/', [PostController, 'index'])
  Route.get('/:id', [PostController, 'show'])
})
```

- Routes are stored in a static registry and mounted into the Hono app during `app.boot()`.
- Controllers are referenced with the `[Class, 'method']` tuple. Helpers such as `Route.resource()` are planned for future releases.

## Controllers
Controllers extend `Controller`, which injects the Hono `Context` via `setContext()`. Methods return responses through helpers like `this.inertia()` or `this.json()`.

```ts
export default class PostController extends Controller {
  async index() {
    const posts = await Post.all()
    return this.inertia('posts/Index', { posts })
  }
}
```

- `this.ctx`: Full Hono context.
- `this.request`: Convenience accessor for the underlying Request.
- `this.inertia(component, props, options)`: Creates an Inertia response.

## Models and ORM
Models extend `Model<TRecord>` and connect to Drizzle via `static table`. The layer is intentionally thin—use the helpers for fast CRUD, or drop to Drizzle RQB directly when queries get complex.

```ts
export type PostRecord = typeof posts.$inferSelect

export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord
}
```

- Provides Laravel-style helpers like `Model.all()`, `Model.find(id)`, `Model.findOrFail()`, `Model.first()`, and `Model.create(data)`.
- `recordType` keeps static helpers strongly typed (e.g. `Post.find()` returns `PostRecord | null`).
- Use a provider such as `DatabaseProvider` (which calls `bootModels()`) to invoke `DrizzleAdapter.configure(db)`, making the adapter available to every model. When you need full control, use `Model.query(db)` or the Drizzle database instance directly.

## Inertia.js and Views
- Place React pages under `resources/js/pages/` and reference them by component name.
- The server embeds the Inertia payload inside HTML via the `data-page` attribute.
- The client loads React/Inertia from CDN ESM modules and hydrates the initial page.

## Bootstrapping the Application
`src/main.ts` in a generated project illustrates the boot process:

1. Import routes for their side effects, e.g. `import '@/routes/web'`.
2. Instantiate `const app = new Application({ providers: [DatabaseProvider, ...] })` so services register early.
3. `await app.boot()` to mount routes, run provider boot hooks, and prepare middleware.
4. `await app.listen()` (or use `app.listen()` directly under Bun) to start the HTTP server.

This process runs under Bun as a native module and is triggered by `bun run dev`.

## Database Schema
- Drizzle schema definitions live in `db/schema.ts`.
- `config/database.ts` provisions tables when the container starts.
- A migration runner is under design; future iterations will likely integrate Drizzle SQL migrations.

## Request Lifecycle
1. Hono receives an HTTP request.
2. The `Route` registry resolves the matching handler.
3. The controller executes, using models to access the database.
4. `this.inertia()` hands data to the view and builds the Inertia response.
5. The client hydrates React on the first load; subsequent navigation stays within Inertia-powered SPA transitions.

## Roadmap (Highlights)
- Official template generator CLI (`bunx guren create <name>`).
- Integrated migration runner.
- Authentication scaffolding and policy support.
- Advanced frontend build options via Vite.

For a deeper dive into internals, explore the [CLI Reference](./cli.md) and the inline documentation within your generated project.

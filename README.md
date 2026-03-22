# Guren Framework

Guren is a Laravel-inspired fullstack framework for TypeScript that runs on Bun. It pairs a familiar MVC developer experience with modern tooling such as the Hono HTTP server, Inertia.js + React for the frontend, and Drizzle ORM for database access. The framework ships as a monorepo with reusable packages and example applications.

## Features

- Bun-native runtime that boots a Hono server with minimal overhead
- Laravel-style routing, controllers, and Eloquent-inspired model API
- Inertia.js + React pages for SPA-like UX without maintaining a separate frontend app
- Drizzle ORM integration with adapter pattern for swapping database backends
- Batteries-included CLI with scaffolding, dev tooling, and route/page code generation

## Project Status

Guren is currently considered **alpha** software. Expect rapid iteration and potentially breaking changes while the roadmap is completed. Feedback and early adopters are encouraged.

## Architecture Overview

- **Runtime:** Bun (v1.1+) executes the Hono-powered HTTP server.
- **Routing:** Export a registrar from `routes/web.ts` and register routes against an app-local `Router` instance.
- **Controllers:** Extend the base `Controller` class to gain helpers such as `this.inertia()`, `this.json()`, and request context access.
- **Views:** React components in `resources/js/pages/` are rendered via Inertia.js, with Vite powering assets.
- **ORM:** Models are typically defined with `defineModel()` on top of a Drizzle table and delegate to the configured `ORMAdapter`.
- **Public API:** Import application APIs from `@guren/core`, runtime helpers from `@guren/core/runtime`, and Vite integration from `@guren/core/vite`.
- **CLI:** Toolkit lives under `packages/cli` and centralizes runtime commands in `runtime.ts` while generators reside alongside scaffolding utilities.

## Getting Started

### Quick Start

Create a new Guren application with the vNext standard flow:

```bash
bunx create-guren-app my-app --mode ssr
cd my-app
bun install
bunx guren add auth
bunx guren add resource posts
bunx guren add queue
bunx guren add mail
bunx guren add events
bunx guren add cache
bunx guren add notifications
bunx guren add storage
bunx guren add broadcasting
bunx guren add schedule
bun run codegen
bun run db:migrate
bun run db:seed
bun run dev
```

Visit `http://localhost:3000` to see your application running!

### Prerequisites

- [Bun](https://bun.sh/) v1.1.0 or newer (`bun --version`)
- Docker (for running the bundled PostgreSQL instance)

### Installation

1. Install dependencies:
   ```bash
   bun install
   ```
2. Start the Postgres container (runs on port 54322 by default):
   ```bash
   bun run db:up
   ```
3. Boot the development server:
   ```bash
   bun run dev
   ```
4. Visit the URL printed by the dev server (typically `http://localhost:3000`).

To stop the database container, run `bun run db:down`. Logs are available via `bun run db:logs`.

### Workspace Scripts

- `bun run build` – build every package (routes types, testing utilities, ORM, server, CLI, core, inertia client)
- `bun run dev` – start the demo application in development mode
- `bun run db:migrate` / `bun run db:seed` – execute migrations or seeders for the demo application

### Production Builds

When preparing the blog example (or any Guren app) for production, build both the client and SSR bundles so the server can stream pre-rendered HTML:

```bash
cd examples/blog
bun run build
```

`src/main.ts` reads the generated manifest files through `@guren/core/runtime` to populate `GUREN_INERTIA_ENTRY`, `GUREN_INERTIA_STYLES`, and `GUREN_INERTIA_SSR_ENTRY`, enabling Inertia's server-side rendering path by default.

## Project Structure

- `packages/core/` – framework runtime, routing, controllers, middleware
- `packages/server/` – server bootstrap helpers around Hono
- `packages/orm/` – ORM adapter abstraction and Drizzle integration
- `packages/cli/` – CLI commands, scaffolding, and route type generation
- `packages/inertia-client/` – frontend integration utilities
- `packages/testing/` – shared testing helpers
- `examples/` – reference applications demonstrating framework usage
- `app/`, `config/`, `resources/` – application skeleton used by the examples and generators

## Development Workflow

1. Export a route registrar from `routes/web.ts`, import framework APIs from `@guren/core`, pass the registrar to `createApp({ routes, providers })`, then call `app.boot()` followed by `app.listen()`.
2. Use the `bunx guren` CLI for scaffolding and tooling:
   ```bash
   bunx guren make:controller UserController
   bunx guren make:model User
   bunx guren make:view users/Index
   bunx guren add auth
   bunx guren add resource posts
   bunx guren add queue
   bunx guren add mail
   bunx guren add events
   bunx guren add cache
   bunx guren add notifications
   bunx guren add storage
   bunx guren add broadcasting
   bunx guren add schedule
   bunx guren codegen --routes routes/web.ts --out types/generated/routes.d.ts
   bunx guren dev
   ```
3. Configure the ORM via `DatabaseProvider`, which wires the `DrizzleAdapter`, runs migrations, and seeds data using `configureOrm()`.

### Authentication

Guren provides built-in authentication scaffolding with automatic configuration:

```bash
bunx guren add auth
```

This command scaffolds:
- **Controllers:** `LoginController` for authentication and `DashboardController` for protected routes
- **Models:** `User` model extending `AuthenticatableModel` with password hashing support
- **Providers:** `AuthProvider` using the `auth.useModel()` shorthand API
- **Validators:** `LoginValidator` with Zod schema validation
- **Views:** Login page and dashboard with React/Inertia.js
- **Database:** Migration for users table and seeder for demo user
- **Routes:** Auth routes (`/login`, `/logout`, `/dashboard`)

#### What `--install` Does

The `--install` flag automatically wires everything up:
- ✅ Registers `AuthProvider` in your `Application` providers array
- ✅ Adds session middleware with defaults (`cookieSecure` is `true` in production, `false` in dev)
- ✅ Wires `registerAuthRoutes(router)` into `routes/web.ts`
- ✅ Safe and idempotent - won't duplicate existing configuration

#### Manual Setup (without auto-wiring)

If you prefer to configure manually or already have partial setup:

```bash
bunx guren make:auth  # scaffold files only
```

Then manually add to your `src/app.ts`:

```typescript
import { createApp } from '@guren/core'
import AuthProvider from '../app/Providers/AuthProvider.js'
import registerWebRoutes from '../routes/web.js'

const app = createApp({
  routes: registerWebRoutes,
  providers: [AuthProvider],
  auth: {
    autoSession: true,
    sessionOptions: {
      cookieSecure: false,
    },
  },
})
```

And register auth routes in `routes/web.ts`:

```typescript
import { Router } from '@guren/core'
import { registerAuthRoutes } from './auth.js'

export function registerWebRoutes(router: Router): void {
  registerAuthRoutes(router)
}
```

#### After Scaffolding

Run migrations and seed the database:
```bash
bun run db:migrate
bun run db:seed
```

Visit `/login` to sign in with the demo user:
- **Email:** `demo@example.com`
- **Password:** `secret`

#### Using `auth.useModel()` Shorthand

The generated `AuthProvider` uses a simplified API:

```typescript
export default class AuthProvider implements Provider {
  register(context: ApplicationContext): void {
    context.auth.useModel(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    })
  }
}
```

This single method call:
- Registers a `ModelUserProvider` with the specified columns
- Creates a `SessionGuard` with proper session handling
- Sets up the default guard as 'web'
- Uses `ScryptHasher` for password hashing by default

For advanced use cases, you can still manually configure providers and guards.

## CLI Reference

Guren provides a comprehensive CLI for scaffolding and development:

### Project Creation

```bash
# Create a new Guren application
bunx create-guren-app my-app

# Create with SSR mode (default)
bunx create-guren-app my-app --mode ssr

# Create with SPA mode
bunx create-guren-app my-app --mode spa

# Create with authentication scaffolding prompt
bunx create-guren-app my-app --auth

# Force overwrite existing directory
bunx create-guren-app my-app --force
```

### Scaffolding Commands

```bash
# Generate a controller
bunx guren make:controller PostController

# Generate a model
bunx guren make:model Post

# Generate a view component
bunx guren make:view posts/Index

# Generate a test file
bunx guren make:test PostTest --runner bun

# Generate a route group
bunx guren make:route api

# Generate authentication scaffolding
bunx guren make:auth --install

# Generate a migration
bunx guren make:migration create_posts_table
```

### Database Commands

```bash
# Run pending migrations
bunx guren db:migrate

# Seed the database
bunx guren db:seed
```

### Development Commands

```bash
# Start development server
bunx guren dev

# Generate route helpers, page manifests, data types, and API client
bunx guren codegen --routes routes/web.ts --out types/generated/routes.d.ts

# Open REPL console
bunx guren console
```

### Flags

- `--force` / `-f`: Overwrite existing files
- `--install` / `-i`: Auto-wire configuration (for `make:auth`)

## End-to-End Type Safety

Guren provides six-directional type safety from your database schema to your frontend components — with zero manual type definition files. Run `bunx guren codegen` to generate all type artifacts at once.

### Generated Artifacts

The `codegen` command produces four files in the `.guren/` directory:

| File | Purpose |
|---|---|
| `pages.gen.ts` | Page manifest with auto-extracted Props types from React components |
| `routes.gen.ts` | Route manifest with typed `route()` helper and `RouteParams` |
| `data.gen.ts` | `Data` namespace extracted from `JsonResource.toArray()` return types |
| `api-client.gen.ts` | Typed `ApiRoutes` interface and `createApiClient()` for separate frontends |

### Route-Level Schema Binding

Attach Zod schemas directly to route definitions for automatic body/params type extraction:

```typescript
// routes/web.ts
import { PostPayloadSchema, PostIdParamSchema } from '../app/Http/Validators/PostValidator.js'

posts.post('/', { body: PostPayloadSchema, name: 'posts.store' }, [PostController, 'store'])
posts.put('/:id', { body: PostPayloadSchema, params: PostIdParamSchema, name: 'posts.update' }, [PostController, 'update'])
```

The codegen extracts schema types at runtime and generates typed `body` fields in `ApiRoutes`:

```typescript
// Auto-generated .guren/api-client.gen.ts
export interface ApiRoutes {
  'posts.store': {
    method: 'POST'
    path: '/posts'
    params: Record<string, never>
    body: { title: string; excerpt: string; body: string }
  }
}
```

### Route Model Binding

Bind route parameters to model classes for automatic resolution:

```typescript
// routes/web.ts
import { Post } from '../app/Models/Post.js'

posts.get('/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
posts.put('/:id', { body: PostPayloadSchema, bind: { id: Post }, name: 'posts.update' }, [PostController, 'update'])
```

Access the resolved model in your controller with `this.model()`:

```typescript
// PostController.ts
async edit() {
  const post = this.model(Post)  // typed as PostRecord, already fetched via findOrFail
  return this.inertia(pages.posts.Edit, { post })
}

async update() {
  const post = this.model(Post)
  const data = await this.validateBody(PostPayloadSchema)
  await Post.update({ id: post.id }, data)
  return this.redirect(`/posts/${post.id}`)
}
```

### Type-Safe Inertia Render

Page components that define a `Props` interface get automatic type checking — no `contracts.ts` or manual type files needed:

```tsx
// resources/js/pages/posts/Show.tsx
interface Props {
  post: { id: number; title: string; body: string }
}

export default function Show({ post }: Props) { /* ... */ }
```

The codegen extracts `Props` via Babel AST and generates `PagePropsMap`, enabling compile-time validation in controllers:

```typescript
// Controller — props mismatch is a compile error
return this.inertia(pages.posts.Show, { post: resource.toJSON() })
```

### Resource Data Types

`JsonResource` subclasses with typed `toArray()` methods are automatically exported:

```typescript
// Auto-generated .guren/data.gen.ts
export namespace Data {
  export type Post = { id: number; title: string; excerpt: string; author?: Data.User }
  export type User = { id: number; name: string; email: string }
}
```

Import `Data` types in your frontend for typed API responses without manual duplication.

### Typed API Client

For separate frontend applications (React SPA, Next.js, Nuxt, etc.):

```typescript
import { createApiClient } from '../.guren/api-client.gen'
import type { ApiRoutes } from '../.guren/api-client.gen'

const client = createApiClient<ApiRoutes>({ baseUrl: 'http://localhost:3000' })

// ✅ Route name autocomplete, params type-checked
const res = await client.request('posts.show', { params: { id: 1 } })

// ❌ Compile error: missing required param 'id'
const res = await client.request('posts.show')
```

### Bidirectional Form Types

Use `RouteBody` and `RouteErrors` for type-safe form submissions:

```typescript
import type { RouteBody, RouteErrors } from '@guren/inertia-client/typed-forms'

type PostForm = RouteBody<ApiRoutes, 'posts.store'>
// → { title: string; excerpt: string; body: string }

type PostErrors = RouteErrors<PostForm>
// errors.title  — ✅ autocomplete
// errors.titl   — ❌ compile error
```

### Type-Safe `<Link>` and `<Form>` Components

Route-name-based navigation with compile-time parameter checking:

```tsx
import { createTypedLink, createTypedForm } from '@guren/inertia-client'
import { routeManifest } from '../.guren/routes.gen'

const Link = createTypedLink(routeManifest)
const Form = createTypedForm(routeManifest)

// ✅ Route name autocomplete, params type-checked
<Link route="posts.show" params={{ id: 1 }}>View post</Link>

// ❌ Compile error: missing required param 'id'
<Link route="posts.show">View post</Link>

// ❌ Compile error: 'posts.shwo' is not a valid route
<Link route="posts.shwo" params={{ id: 1 }}>View post</Link>

// ✅ Form with typed route
<Form route="posts.store" method="post">
  <input name="title" />
  <button type="submit">Create</button>
</Form>
```

### Vite HMR Integration

The Vite plugin watches routes, pages, and resources for changes and regenerates types automatically during development. Edit a page's Props or a Resource's `toArray()` and see type errors instantly.

## Database

- Docker Compose service name: `postgres`
- Connection string: `postgres://guren:guren@localhost:54322/guren`
- Credentials: user `guren`, password `guren`, database `guren`
- Schema definitions live in `db/schema.ts` and are consumed by models through the static `table` property.

## Roadmap

Status details live in `ROADMAP.md`.

- [x] Routing parity with resource routes, named routes, scoped groups, and route contracts
- [x] Framework-level validation pipeline with 49 built-in rules, Validator class, FormRequest, and Zod integration
- [x] Expanded ORM features: full relationships (hasMany, hasOne, belongsTo, belongsToMany, hasManyThrough, morphMany, morphTo), eager loading, QueryBuilder, global scopes, soft deletes, and observers
- [x] Comprehensive auth/authorization suite with password reset, email verification, API tokens, policies, and gates
- [x] Asynchronous tooling: queues (Memory/Redis), events, broadcasting (SSE), scheduler (cron), cache (Memory/Redis/File), and notifications (Mail/Database/Slack)
- [x] Storage integrations: Local, S3, and Memory drivers with StorageManager
- [x] Developer experience: 40+ CLI commands, Artisan-style console kernel, comprehensive testing utilities, project creator, and feature blueprints
- [x] Database lifecycle commands: `db:migrate`, `db:seed`, `db:reset`, `db:fresh`, `db:rollback`, and `db:status`
- [x] First-party plugins: auth, mail (SMTP/Resend), queue, cache, notifications, broadcasting, scheduler, logging, i18n, health checks, encryption, rate limiting, API resources, DI container, facades, and auto-discovery
- [ ] Database adapters: MySQL support (Postgres and SQLite implemented)
- [x] Route model binding (`bind: { id: Post }`) with typed `this.model(Post)` controller helper
- [ ] OAuth/social authentication providers and JWT guard
- [ ] Release and compatibility policy: Bun/Node compatibility matrix and migration guides per minor release
- [ ] Documentation and learning: end-to-end tutorial, deployment recipes (Docker/Edge/Serverless), and troubleshooting docs
- [ ] Quality and reliability: integration/E2E coverage, perf/footprint benchmarks, and nightly canary builds
- [ ] Community process: contribution templates, RFC workflow for breaking changes, and regular changelog/release notes

## Contributing

Issues, discussions, and pull requests are welcome. Please review the [contributing guide](./CONTRIBUTING.md) for environment setup, testing instructions, and our preferred workflow. Run `bun run test` and `bun run build` before opening a pull request.

## License

Released under the [MIT License](./LICENSE).

# Guren Framework - AI Coding Instructions

## Architecture Overview

**Guren** is a Laravel-inspired TypeScript fullstack MVC framework running on Bun. It combines:
- **Bun runtime** + **Hono HTTP server** for backend
- **Inertia.js** + **React** for SPA-like frontend 
- **Drizzle ORM** with Eloquent-style Model API
- **Monorepo structure** with `packages/` (framework) and `examples/` (demo apps)

## Key Framework Patterns

### MVC Structure
- **Routes**: Laravel-style DSL in `routes/web.ts` using `Route.get()`, `Route.group()`, etc.
- **Controllers**: Extend `Controller` base class, use `this.inertia()` for page responses
- **Models**: Extend `Model<TRecord>` with static `table` property pointing to Drizzle schema
- **Views**: React components in `resources/js/pages/` rendered via Inertia

### Route & Controller Pattern
```typescript
// routes/web.ts
Route.group('/posts', () => {
  Route.get('/', [PostController, 'index'])
  Route.get('/:id', [PostController, 'show'])
})

// Controllers use array syntax: [ControllerClass, 'methodName']
// Controllers access context via this.ctx, return this.inertia() for pages
```

### Model & ORM Pattern
```typescript
// Models define their record type from the Drizzle table helpers
export type PostRecord = typeof posts.$inferSelect
export class Post extends Model<PostRecord> {
  static override table = posts // Drizzle schema
  static override readonly recordType = {} as PostRecord
}

// Usage: Post.all(), Post.find(id), Post.create(data)
```

## Development Workflow

### CLI Tooling
- **citty** powers all CLI argument parsing (e.g. `packages/core/src/cli/bin.ts`, `packages/create-app/src/cli.ts`)
- **consola** is the standard logger for CLI feedback (success/info/error)
- Prefer defining subcommands with `defineCommand()` and wiring the root command via `runMain()`
- Reuse shared option helpers (such as the `force` writer option) instead of ad-hoc flag parsing
- Keep runtime-oriented commands (`dev`, `console`, future boot helpers) in `packages/cli/src/runtime.ts` so generators stay separated from application bootstrapping.
- Route type generation lives in `packages/cli/src/routes-types.ts`; adjust both the CLI command and Vite plugin output when changing declaration format.

### Project Structure
- **Framework code**: `packages/core/src/` - the Guren framework itself
- **Demo apps**: `examples/blog/` - reference implementation
- **Monorepo**: Uses Bun workspaces, run commands with `--cwd` flag
- **Commits**: Follow the [Conventional Commits](./CONTRIBUTING.md#commit-message-convention) format

### Essential Commands
```bash
# Start development (from repo root)
bun run dev                    # Runs examples/blog
bun run db:up                  # Start Postgres in Docker
bun run build                  # Build core framework

# CLI tools (framework features)
bunx guren make:controller UserController
bunx guren make:model User
bunx guren make:view users/Index
bunx guren make:test auth/Login --runner vitest
bunx guren make:auth --force
bunx guren routes:types --routes routes/web.ts --out types/generated/routes.d.ts
bunx guren console
bunx guren dev
```

### Application Bootstrap Pattern
1. Import routes in `src/main.ts` (side-effect based registration)
2. Create an `Application` instance, registering any providers (e.g. `DatabaseProvider`) that prepare services
3. Call `app.boot()` then `app.listen()`

## Framework-Specific Conventions

### Inertia.js Integration
- Use `this.inertia(component, props, options)` in controllers
- Component names map to `resources/js/pages/` file structure
- Example apps use Vite for dev/production assets—`configureInertiaAssets` wires `GUREN_INERTIA_ENTRY`/`GUREN_INERTIA_STYLES` with the manifest output.
- Initial page data embedded in HTML via `data-page` attribute

### Static Route Registry
- Routes are registered statically in `Route` class registry
- Import route files as side effects (no explicit calls needed)
- All routes mounted when `app.boot()` is called via `Route.mount(hono)`

### ORM Adapter Pattern
- Models use adapter pattern with `ORMAdapter` interface
- Default is `DrizzleAdapter`, configured via `DrizzleAdapter.configure(db)`
- Models automatically use configured adapter for queries

### Controller Context Access
- Controllers receive Hono `Context` via `setContext()` method
- Access via protected `this.ctx` getter, `this.request` helper
- Return `Response` objects (use `this.inertia()`, `this.json()`, `this.redirect()`)

## Database & Docker Setup

### PostgreSQL Configuration
- Uses Docker Compose with service name `postgres`
- Port: 54322 (non-standard to avoid conflicts)
- Credentials: `guren/guren/guren` (user/pass/db)
- Connection string: `postgres://guren:guren@localhost:54322/guren`

### Database Workflow
1. Schema defined in `db/schema.ts` using Drizzle
2. `config/database.ts` calls `createPostgresDatabase` to expose `configureOrm`, migration, and seeding helpers.
3. ORM configured via `DatabaseProvider` (internally calls `bootModels()` to run `configureOrm`/`seedDatabase` once)
4. Models reference schema tables via static `table` property

## File Naming & Organization

### Standard Locations
- **Routes**: `routes/web.ts` (register all routes here)
- **Controllers**: `app/Http/Controllers/` with `Controller` suffix
- **Models**: `app/Models/` matching database table name
- **Views**: `resources/js/pages/` matching controller method structure
- **Config**: `config/` directory for app, database configuration
- **Entry**: `src/main.ts` for application bootstrap

### Import Patterns
- Framework exports from `'guren'` package
- Controllers import as default exports: `import PostController from '@/path'`
- Models export both type and class: `export type PostRecord = typeof posts.$inferSelect; export class Post`
- Routes use controller array syntax: `[PostController, 'index']`

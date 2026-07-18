# Guren Framework

## Overview
Guren is a Laravel-inspired fullstack TypeScript framework running on Bun. It combines Hono for HTTP handling, Drizzle ORM for database operations, and Inertia.js for seamless frontend integration.

**Status:** Stable (v1.0). Breaking changes only in major releases.

## Monorepo Structure

```
packages/
├── core/           # Framework entry point, aggregates other packages
├── server/         # HTTP server (Hono), routing, controllers, middleware, auth
├── orm/            # ORM abstraction with Drizzle adapter, Model API
├── cli/            # CLI commands (make:*, db:*, routes:types, AI agent commands)
├── testing/        # Testing utilities for controllers and HTTP
├── create-app/     # Project scaffolding tool
└── inertia-client/ # Frontend React + Inertia.js integration

examples/
└── blog/           # Reference application

web/                # Documentation site
```

## Development Commands

```bash
# Build all packages (required after code changes)
bun run build

# Run tests
bun run test:bun      # Framework unit tests
bun run test:examples # Example app tests
bun run test          # Full test suite

# Type checking
bun run typecheck

# Development server (blog example)
bun run dev

# Database
bun run db:up         # Start PostgreSQL container
bun run db:down       # Stop container
bun run db:migrate    # Run migrations
bun run db:seed       # Run seeders
```

## Build Order & Troubleshooting

`bun run build` executes packages sequentially in dependency order:
`testing → orm → server → openapi → cli → core → create-app → inertia`

**Stale `.d.ts` issue:** If DTS build fails (e.g., `@guren/core` cannot find `@guren/server` types), old `dist/` artifacts are likely interfering. Run:
```bash
bun run build:clean   # rm -rf packages/*/dist && bun run build
```

**Rule:** Always use `bun run build:clean` instead of `bun run build` when:
- Building after switching branches
- Building after pulling large changes
- DTS build fails with "could not find declaration file" errors

## Package-Specific Builds

```bash
bun run build:server  # Build @guren/server
bun run build:orm     # Build @guren/orm
bun run build:cli     # Build @guren/cli
# etc.
```

## AI Agent Commands

Commands designed for AI coding agents to understand, validate, and generate code:

```bash
# Project introspection
bunx guren context              # Project context map (markdown)
bunx guren context --json       # Project context map (JSON)
bunx guren model:list           # List models with relationships
bunx guren model:list --format json  # Models as JSON

# Integrity checking
bunx guren check                # Validate route↔controller↔page consistency
bunx guren check --json         # Check results as JSON
bunx guren audit                # Security audit: validation/auth on mutating routes, raw SQL, secrets, mass assignment
bunx guren audit --json         # Audit results as JSON (exits non-zero on failures)
bunx guren doctor --next        # Doctor report + actionable next steps

# Code generation
bunx guren guidelines           # Auto-generate project-specific coding guidelines
bunx guren guidelines -o .claude/rules/project-guidelines.md  # Write to file
bunx guren make:feature Post --fields "title:string,body:text,published:boolean"  # CRUD scaffold (store/update require auth by default)
bunx guren make:feature Post --fields "title:string,body:text" --test  # With test file
bunx guren make:feature Post --fields "title:string" --public  # Skip auth checks in mutating actions
bunx guren make:feature Post --fields "title:string" --policy  # Also generate a policy and enforce it in store/update
bunx guren make:policy Post     # Authorization policy scaffold (app/Policies)
```

## Coding Conventions

### TypeScript
- **Strict mode** enabled (`strict: true`)
- **ES2022** target with ESNext modules
- **Bundler** module resolution
- Use **Bun native APIs** where applicable
- **No CommonJS** - ESM only

### File Organization
- Test files: `*.test.ts` alongside source files
- Index exports: Each package has `src/index.ts` as main entry
- Type declarations: Generated via tsup build

### Naming
- **Classes:** PascalCase (e.g., `UserController`, `PostModel`)
- **Files:** kebab-case for utilities, PascalCase for classes
- **Variables/functions:** camelCase
- **Constants:** UPPER_SNAKE_CASE for true constants

### Imports
```typescript
// Use package aliases
import { Controller } from '@guren/server'
import { Model } from '@guren/orm'

// Relative imports within same package
import { helper } from './utils'
```

## Architecture Patterns

### Controllers
```typescript
import { Controller } from '@guren/core'
import { z } from 'zod'
import { pages } from '@/.guren/pages.gen'

const CreatePostSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
})

const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export class PostController extends Controller {
  async index() {
    const posts = await Post.all()
    return this.inertia(pages.posts.Index, { posts })
  }

  async show() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)  // throws 404 automatically
    return this.inertia(pages.posts.Show, { post })
  }

  async store() {
    const data = await this.validateBody(CreatePostSchema)  // throws 422 on failure
    const user = await this.auth.userOrFail()  // throws 401 if unauthenticated
    const post = await Post.create({ ...data, authorId: user.id })
    return this.redirect('/posts')
  }
}
```

**Controller validation helpers** (accepts any Zod-like schema with `safeParse`):
- `this.validateBody(schema)` — parse request body, throw `ValidationException` (422) on failure
- `this.validateQuery(schema)` — parse query parameters
- `this.validateParams(schema)` — parse route parameters

### Models
```typescript
import { Model } from '@guren/orm'
import { posts } from '@/db/schema'

export class Post extends Model<typeof posts> {
  static table = posts

  // Relationships, scopes, etc.
}

// Usage
const post = await Post.find(1)          // returns null if not found
const post = await Post.findOrFail(1)    // throws ModelNotFoundException (404)
const all = await Post.where('published', true).get()
```

### Routes
```typescript
import { Router, requireAuthenticated } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))

  router.get('/posts', [PostController, 'index'])
  router.post('/posts', [PostController, 'store'])

  router.middleware('auth').group((auth) => {
    auth.get('/dashboard', [DashboardController, 'index'])
  })
}
```

### Middleware
```typescript
import { defineMiddleware } from '@guren/core'

export const requireAuth = defineMiddleware(async (c, next) => {
  if (!c.get('user')) {
    return c.redirect('/login')
  }
  await next()
})
```

### Application Bootstrap
1. Export a route registrar from `routes/web.ts`
2. Create the app with `createApp({ routes, providers })`
3. Call `app.boot()` then `app.listen()`

### Database Configuration
- PostgreSQL via Docker Compose (service: `postgres`)
- Port: `54322` (non-standard to avoid conflicts)
- Credentials: `guren/guren/guren` (user/pass/db)
- Connection string: `postgres://guren:guren@localhost:54322/guren`

**Database workflow:**
1. Schema defined in `db/schema.ts` using Drizzle
2. `config/database.ts` calls `createPostgresDatabase` to expose `configureOrm`, migration, and seeding helpers
3. ORM configured via `DatabaseProvider` (internally calls `bootModels()` to run `configureOrm`/`seedDatabase` once)
4. Models reference schema tables via static `table` property

### End-to-End Type Safety
- `bunx guren codegen` generates four artifacts in `.guren/`: `pages.gen.ts`, `routes.gen.ts`, `data.gen.ts`, `api-client.gen.ts`
- **Route Schema Binding**: Attach Zod schemas to routes via `RouteContractOptions` (`body`, `params`, `query`); codegen extracts schema types and generates typed `body` fields in `ApiRoutes`
- **Route Model Binding**: `bind: { id: Post }` in route options + `this.model(Post)` in controllers for typed, auto-resolved model instances
- **Page Props**: Define `interface Props` in page components; codegen extracts them via Babel AST into `PagePropsMap` for compile-time validation in `this.inertia()`
- **Data Types**: `JsonResource` subclasses with typed `toArray()` are exported as `Data.Post`, `Data.User`, etc.
- **API Client**: `createApiClient<ApiRoutes>()` provides typed `request()` with route name autocomplete, param checking, and body types
- **Bidirectional Forms**: `RouteBody<ApiRoutes, 'posts.store'>` and `RouteErrors<PostForm>` from `@guren/inertia-client/typed-forms`
- **Typed Components**: `createTypedLink(routeManifest)` and `createTypedForm(routeManifest)` provide `<Link route="posts.show" params={{ id: 1 }}>` with compile-time route name and param checking
- **Vite HMR**: The Vite plugin watches `routes/web.ts`, `resources/js/pages/`, and `app/Http/Resources/` — changes trigger automatic codegen

## Testing

### Framework Tests
Uses Bun's native test runner:
```typescript
import { describe, test, expect } from 'bun:test'

describe('Feature', () => {
  test('should work', () => {
    expect(true).toBe(true)
  })
})
```

### Controller Tests
```typescript
import { TestApp } from '@guren/testing'

test('index returns posts', async () => {
  const app = await TestApp.create()
  await app.get('/posts').assertOk()
})
```

## Commit Convention

Follow [Conventional Commits](https://conventionalcommits.org):

```
<type>(<scope>): <summary>

<body>

<footer>
```

**Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `build`, `ci`, `perf`, `chore`

**Scopes:** `server`, `orm`, `cli`, `testing`, `core`, `docs`

**Examples:**
```
feat(server): add rate limiting middleware
fix(orm): handle null values in where clause
docs: update authentication guide
```

## Serverless (AWS Lambda)

Guren supports AWS Lambda deployment via `@guren/server/lambda`:

```typescript
// lambda.ts
import app from './src/app'
import { createLambdaHandler } from '@guren/server/lambda'

await app.boot()
export const handler = createLambdaHandler(app)
```

**Key points:**
- `app.boot()` runs once at cold start; the handler reuses the booted app
- Use `NodeHasher` instead of `ScryptHasher` for password hashing on Node.js runtimes
- Static assets should be served via CloudFront/S3, not Lambda
- Use Redis-backed session/cache/queue stores (not in-memory)
- List providers explicitly in `createApp()` (auto-discovery requires Bun)

## Key Files

| Path | Purpose |
|------|---------|
| `packages/server/src/http/Application.ts` | Main server class |
| `packages/server/src/mvc/Controller.ts` | Base controller (validateBody/Query/Params) |
| `packages/server/src/mvc/Router.ts` | Instance-based route registry |
| `packages/server/src/errors/ExceptionHandler.ts` | Exception handler (duck-type statusCode) |
| `packages/orm/src/Model.ts` | Base model class (findOrFail) |
| `packages/orm/src/ModelNotFoundException.ts` | 404 exception for models |
| `packages/server/src/lambda/index.ts` | AWS Lambda adapter |
| `packages/server/src/auth/password/NodeHasher.ts` | Node.js-compatible password hasher |
| `packages/cli/src/bin.ts` | CLI entry point |
| `packages/cli/src/context.ts` | AI agent: project context map generation |
| `packages/cli/src/check.ts` | AI agent: integrity checking |
| `packages/cli/src/audit.ts` | AI agent: security audit (validation, auth, raw SQL, secrets) |
| `packages/cli/src/guidelines.ts` | AI agent: dynamic guidelines generation |
| `packages/cli/src/model-list.ts` | AI agent: model introspection |
| `packages/cli/src/model-parser.ts` | AI agent: Babel AST model parsing |
| `packages/cli/src/make-feature.ts` | AI agent: CRUD feature scaffolding |
| `packages/cli/src/discovery.ts` | AI agent: shared file discovery utilities |
| `examples/blog/` | Reference implementation |

## Before Opening PRs

1. Run `bun run build` - ensure all packages compile
2. Run `bun run typecheck` - no type errors
3. Run `bun run test` - all tests pass
4. Run `bun run audit:core-first` - no `@guren/server` references in docs/templates
5. Run `bun run audit:docs` - docs reference valid commands and APIs
6. Review `.claude/rules/common-pitfalls.md` - check for known gotchas
7. Follow commit message convention

## Claude Code Agents

Specialized subagents that run in isolated context for complex tasks:

| Agent | Trigger Words | Purpose |
|-------|---------------|---------|
| `code-review` | "review", "check my code" | Review code changes for quality, patterns, security |
| `test-writer` | "write tests", "add tests" | Generate comprehensive tests for existing code |

## Claude Code Skills

Available AI-powered skills that Claude can use automatically:

| Skill | Trigger Words | Purpose |
|-------|---------------|---------|
| `dev-workflow` | "build", "test", "typecheck", "pr check", "e2e", "dev server" | Build, test (smart/full), type check, pre-PR validation, E2E tests, dev server |
| `scaffold` | "create a controller", "make a job", "new event" | Generate individual components using `bunx guren make:*` |
| `feature` | "full feature", "CRUD", "everything for" | Generate complete CRUD feature with all components at once |
| `db-manage` | "database", "migration", "reset", "rollback" | Database operations (migrate, rollback, seed, reset) with safety checks |
| `guren-api` | "how to", "example of", "what is" | API documentation for all subsystems (auth, cache, queue, mail, events, etc.) |

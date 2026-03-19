# Guren Framework

## Overview
Guren is a Laravel-inspired fullstack TypeScript framework running on Bun. It combines Hono for HTTP handling, Drizzle ORM for database operations, and Inertia.js for seamless frontend integration.

**Status:** Alpha (v0.2.x) - Breaking changes expected.

## Monorepo Structure

```
packages/
├── core/           # Framework entry point, aggregates other packages
├── server/         # HTTP server (Hono), routing, controllers, middleware, auth
├── orm/            # ORM abstraction with Drizzle adapter, Model API
├── cli/            # CLI commands (make:*, db:*, routes:types)
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

## Package-Specific Builds

```bash
bun run build:server  # Build @guren/server
bun run build:orm     # Build @guren/orm
bun run build:cli     # Build @guren/cli
# etc.
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
import { Controller } from '@guren/server'
import { z } from 'zod'

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
    return this.inertia('Posts/Index', { posts })
  }

  async show() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)  // throws 404 automatically
    return this.inertia('Posts/Show', { post })
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
import { Route } from '@guren/server'

Route.get('/posts', PostController.index)
Route.post('/posts', PostController.store)
Route.resource('/users', UserController)

// With middleware
Route.middleware(['auth']).group(() => {
  Route.get('/dashboard', DashboardController.index)
})
```

### Middleware
```typescript
import { defineMiddleware } from '@guren/server'

export const requireAuth = defineMiddleware(async (c, next) => {
  if (!c.get('user')) {
    return c.redirect('/login')
  }
  await next()
})
```

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
import { createTestContext } from '@guren/testing'

test('index returns posts', async () => {
  const ctx = createTestContext()
  const response = await ctx.get('/posts')
  expect(response.status).toBe(200)
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

## Key Files

| Path | Purpose |
|------|---------|
| `packages/server/src/http/Application.ts` | Main server class |
| `packages/server/src/mvc/Controller.ts` | Base controller (validateBody/Query/Params) |
| `packages/server/src/mvc/Route.ts` | Route registry |
| `packages/server/src/errors/ExceptionHandler.ts` | Exception handler (duck-type statusCode) |
| `packages/orm/src/Model.ts` | Base model class (findOrFail) |
| `packages/orm/src/ModelNotFoundException.ts` | 404 exception for models |
| `packages/cli/src/bin.ts` | CLI entry point |
| `examples/blog/` | Reference implementation |

## Before Opening PRs

1. Run `bun run build` - ensure all packages compile
2. Run `bun run typecheck` - no type errors
3. Run `bun run test` - all tests pass
4. Follow commit message convention

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
| `dev-workflow` | "build", "test", "typecheck", "pr check", "dev server" | Build, test (smart/full), type check, pre-PR validation, dev server |
| `scaffold` | "create a controller", "make a job", "new event" | Generate individual components using `bunx guren make:*` |
| `feature` | "full feature", "CRUD", "everything for" | Generate complete CRUD feature with all components at once |
| `db-manage` | "database", "migration", "reset", "rollback" | Database operations (migrate, rollback, seed, reset) with safety checks |
| `guren-api` | "how to", "example of", "what is" | API documentation for all subsystems (auth, cache, queue, mail, events, etc.) |

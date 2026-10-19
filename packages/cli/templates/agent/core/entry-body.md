## Project Structure

```
app/
├── Http/
│   ├── Controllers/    # Request handlers
│   ├── Middleware/      # HTTP middleware
│   └── Resources/       # API resource transformers
├── Models/              # Drizzle ORM models
├── Events/              # Event classes
├── Listeners/           # Event listeners
├── Jobs/                # Queue job classes
├── Mail/                # Mailable classes
├── Notifications/       # Notification classes
├── Providers/           # Service providers
├── Exceptions/          # Custom exceptions
└── Console/Commands/    # CLI commands
bin/
└── serve.ts             # Server entry point
config/                  # Application configuration
db/
├── schema.ts            # Drizzle table definitions
├── migrations/          # SQL migration files
├── factories/           # Model factories
└── seeders/             # Database seeders
resources/js/
├── pages/               # Inertia.js React pages
├── components/          # Shared React components
└── layouts/             # Page layouts
routes/
├── web.ts               # Web routes
└── api.ts               # API routes (if applicable)
tests/
├── controllers/         # Controller tests
└── models/              # Model tests
```

## Development Commands

```bash
# Start development server
bun run dev

# Generate components
bunx guren make:controller <Name>
bunx guren make:model <Name>
bunx guren make:migration <name>
bunx guren make:view <path>
bunx guren make:middleware <Name>
bunx guren make:job <Name>
bunx guren make:event <Name>
bunx guren make:listener <Name> --event=<EventName>
bunx guren make:mail <Name>
bunx guren make:test <Name>

# Growing past a flat app/? Scaffold a self-contained module:
bunx guren make:module <Name>                    # modules/<name>/{index.ts,routes.ts,db/schema.ts}, wired into src/app.ts
bunx guren make:controller <Name> --module <name> # most make:* commands accept --module

# Database workflow: edit db/schema.ts first, then
bunx guren make:migration <name>   # generate SQL migration via drizzle-kit into db/migrations/
bun run db:migrate                 # apply pending migrations; refuses a drop, narrowing or rename without
                                   # `-- guren:allow-destructive: <reason>` (ask the user first; db-manage skill)
bunx guren db:status               # show applied/pending state
bun run db:seed                    # run seeders
# Migrations are forward-only (no rollback). Dev reset: bunx guren db:reset --seed

# Build & test
bun run build
bun run test
bunx guren gate                    # every CI stage (codegen, typecheck, lint, check, audit, test); exit 0 = done
```

Implementation plans: the `plan-write` and `plan-implement` skills. Browser
verification: the `verify-in-browser` skill. Each lists its own commands.

## MCP Server (AI Agent Integration)

`bun run dev` serves an MCP endpoint at `http://localhost:3333/_guren/mcp`
(loopback only; `GUREN_MCP=1` in the `dev` script). Its tools mirror the CLI
(`guren_get_context`, `guren_check`, `guren_gate`, …); the `dev-workflow` skill
lists them.

## Architecture Overview

The request lifecycle: `routes/web.ts` registers routes on a `Router`, each pointing
at a `[Controller, 'method']` tuple. Controllers validate input with Zod schemas,
query models, and render Inertia pages or JSON.

```typescript
// routes/web.ts
router.get('/posts', [PostController, 'index']).name('posts.index')
router.post('/posts', { name: 'posts.store', body: CreatePostSchema }, [PostController, 'store'])

// app/Http/Controllers/PostController.ts
export class PostController extends Controller {
  async store() {
    const { body: data } = this.validated('posts.store')     // the route's body schema answered 422 already
    const user = await this.auth.userOrFail<UserRecord>()    // 401 if unauthenticated
    const post = await Post.create(data, { set: { authorId: user.id } })  // server-chosen column
    return this.redirect('/posts')
  }
}

// app/Models/Post.ts
export class Post extends defineModel(posts, {
  fillable: ['title', 'body'],  // typed against the table's columns; authorId stays out (set above)
}) {}
```

- Models: `await Post.findOrFail(id)` throws a 404; `Post.where(...)` starts a query
  builder chain. Rules in `__RULES_DIR__/orm-models.md`.
- Attaching a Zod schema to a route both validates the request automatically and
  feeds `bunx guren codegen` typed manifests. Rules in `__RULES_DIR__/routes-codegen.md`.
- Middleware: `defineMiddleware(async (c, next) => { ... })` from `@guren/core`;
  register aliases via `const router = baseRouter.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))`
  — the return value carries the alias name in the router's type, so dropping it makes
  a later `.middleware('auth')` fail to compile.

## Testing

Uses `bun:test` + `@guren/testing`. Requests run in-process via `app.fetch()` — no server needed.

```typescript
import { TestApp } from '@guren/testing'

const app = await TestApp.create()
await app.get('/posts').assertOk()
await app.actingAs(user).json().post('/posts', { title: 'Hi' }).assertCreated()
```

Client, assertions and common mistakes: `__RULES_DIR__/testing.md`.

## Key Files

| Path | Purpose |
|------|---------|
| `bin/serve.ts` | Server entry point |
| `config/` | Application configuration |
| `db/schema.ts` | Database table definitions |
| `routes/web.ts` | Web route definitions |
| `app/Providers/` | Service providers |
| `resources/js/pages/` | React page components |
| `__RULES_DIR__/` | Verified API rules (each file's `paths` frontmatter states the covered paths) |
| `__SKILLS_DIR__/guren-api/reference/` | The full API reference behind each rule, read on demand |

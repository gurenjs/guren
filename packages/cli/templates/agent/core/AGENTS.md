# __APP_TITLE__

## Overview

A fullstack TypeScript application built with the Guren framework (Laravel-inspired, running on Bun).

## AI Agents: Start Here

Before exploring `node_modules`, use the built-in introspection commands:

```bash
bunx guren context         # project map: models, routes, controllers, pages (add --json for JSON)
bunx guren context User    # everything about one entity: model, routes, pages, linked docs — start entity work here
bunx guren check           # validate route ↔ controller ↔ page consistency, doc links, and spec freshness — run after changes
bunx guren docs:graph --path <file>  # which docs govern this file, which spec views derive from it — ask BEFORE renaming/moving
bunx guren codegen         # regenerate .guren/*.gen.ts typed manifests (also runs via `bun run dev`)
bunx guren spec:generate   # regenerate docs/spec/ views (ER, domain, screens, modules) after schema/model/route changes
bunx guren make:adr "..."  # record an architecture decision under docs/adr/ (--entity <Model> links it)
```

## Session Workflow

Nothing runs these steps for you automatically (hook support varies by agent),
so make them part of your loop:

1. **At session start**, run `bunx guren context` and read the output. It ends
   with a "Guren API Signatures" digest of the ORM, controller, and testing
   APIs — read it before writing any code. With the MCP server connected, the
   `guren_get_context` tool returns the same map.
2. **After editing** routes, controllers, models, `db/schema.ts`, or pages,
   run `bunx guren check` and fix what it reports before moving on.
3. Framework-managed files (`.agents/rules/`, `.agents/skills/`) can be
   refreshed anytime with `bunx guren agent:sync`.

Detailed, verified API rules live in `.agents/rules/*.md`; each file's `globs`
frontmatter states which paths it covers — read the matching rule before
editing those paths: `orm-models.md` (models, queries, relations),
`controllers-http.md` (validation, Inertia, auth), `routes-codegen.md`
(route options, schema binding, codegen), `testing.md` (TestApp assertions),
`docs-and-spec.md` (linked ADRs/docs, generated spec views).
For framework signatures, check the `guren context` digest first, then the
matching rule file; only read `node_modules/@guren/*` for APIs neither covers.

Reusable skills (SKILL.md, the Agent Skills format) live in
`.agents/skills/` — agents that support the standard discover them there
automatically.

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
bun run db:migrate                 # apply pending migrations
bunx guren db:status               # show applied/pending state
bun run db:seed                    # run seeders
# Migrations are forward-only (no rollback). Dev reset: bunx guren db:reset --seed
```

## MCP Server (AI Agent Integration)

`bun run dev` starts an MCP endpoint alongside the dev server (enabled by
`GUREN_MCP=1` in the `dev` script; if your script lacks it, run
`GUREN_MCP=1 bun run dev`; the flag has no effect in production):

```
http://localhost:3333/_guren/mcp
```

`bunx guren agent:init` writes the MCP client config for the agents you
selected (for example `.codex/config.toml` for Codex — a project-scoped
config Codex only reads in trusted projects — or the `mcp` entry in
`opencode.json` for OpenCode). If your agent is not configured yet, point it
at the URL above as a streamable-HTTP server.

The endpoint only accepts requests from this machine: browser pages on other
origins (including DNS rebinding) and requests from other hosts on the LAN
are rejected with 403.

### Available tools

| Tool | Description |
|------|-------------|
| `guren_get_context` | Project structure map (models, routes, pages, controllers, …) |
| `guren_entity_context` | Entity-centric context bundle (model, routes, pages, linked docs) |
| `guren_check` | Validate route ↔ controller ↔ page consistency, doc links, spec freshness |
| `guren_docs_graph` | OKF docs relation graph (narrow with entity/path) — impact query before renames |
| `guren_list_models` | List models (relations, soft deletes, auth trait) |
| `guren_generate_guidelines` | Generate project-specific coding guidelines |
| `guren_doctor` | Project health check + suggested next actions |
| `guren_make_feature` | Scaffold a complete CRUD feature |
| `guren_make_component` | Scaffold a single component |
| `guren_codegen` | Generate typed manifests (routes.gen.ts, pages.gen.ts, …) |

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
    const data = await this.validateBody(CreatePostSchema)   // 422 on failure
    const user = await this.auth.userOrFail<UserRecord>()    // 401 if unauthenticated
    const post = await Post.create({ ...data, authorId: user.id })
    return this.redirect('/posts')
  }
}

// app/Models/Post.ts
export class Post extends defineModel(posts, {
  fillable: ['title', 'body', 'authorId'],  // typed against the table's columns
}) {}
```

- Models: `await Post.findOrFail(id)` throws a 404; `Post.where(...)` starts a query
  builder chain. Full API in `.agents/rules/orm-models.md`.
- Attaching a Zod schema to a route both validates the request automatically and
  feeds `bunx guren codegen` typed manifests. Details in `.agents/rules/routes-codegen.md`.
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

Full client and assertion reference: `.agents/rules/testing.md`.

## Key Files

| Path | Purpose |
|------|---------|
| `bin/serve.ts` | Server entry point |
| `config/` | Application configuration |
| `db/schema.ts` | Database table definitions |
| `routes/web.ts` | Web route definitions |
| `app/Providers/` | Service providers |
| `resources/js/pages/` | React page components |
| `.agents/rules/` | Verified API rules (globs frontmatter states the covered paths) |

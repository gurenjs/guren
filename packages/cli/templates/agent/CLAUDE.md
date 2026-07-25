# __APP_TITLE__

## Overview

A fullstack TypeScript application built with the Guren framework (Laravel-inspired, running on Bun).

## AI Agents: Start Here

Before exploring `node_modules`, use the built-in introspection commands:

```bash
bunx guren context         # project map: models, routes, controllers, pages (add --json for JSON)
bunx guren context User    # everything about one entity: model, routes, pages, linked docs — start entity work here
bunx guren check           # validate route ↔ controller ↔ page consistency, doc links, and spec freshness — run after changes
bunx guren codegen         # regenerate .guren/*.gen.ts typed manifests (also runs via `bun run dev`)
bunx guren spec:generate   # regenerate docs/spec/ views (ER, domain, screens, modules) after schema/model/route changes
bunx guren make:adr "..."  # record an architecture decision under docs/adr/ (--entity <Model> links it)
```

This project ships with an agent harness wired into `.claude/settings.json`:
a `SessionStart` hook injects the `guren context` project map, and a
`PostToolUse` hook (`.claude/hooks/check-after-edit.ts`) re-runs `guren check`
after edits to routes, controllers, models, schema, or pages and reports
failures back immediately. Framework-managed files (`.claude/rules`, `skills`,
`agents`, `hooks`) can be refreshed anytime with `bunx guren agent:sync`.

Detailed, verified API rules live in `.claude/rules/*.md` and load automatically
based on the files you are editing (glob-scoped): `orm-models.md` (models, queries,
relations), `controllers-http.md` (validation, Inertia, auth), `routes-codegen.md`
(route options, schema binding, codegen), `testing.md` (TestApp assertions),
`docs-and-spec.md` (linked ADRs/docs, generated spec views).
Read the matching rule file before reading `node_modules/@guren/*` — it covers the
exact signatures.

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

# Build & test
bun run build
bun run test
```

## MCP Server (AI Agent Integration)

`bun run dev` を実行すると、開発サーバーに MCP エンドポイントが自動的に起動します:

```
http://localhost:3333/_guren/mcp
```

`.mcp.json` が設定済みなので、Claude Code / Cursor は自動的に接続します。
本番環境（`NODE_ENV=production`）では無効化されます。

### 利用可能なツール

| Tool | 説明 |
|------|------|
| `guren_get_context` | プロジェクト構造マップ（models, routes, pages, controllers等） |
| `guren_entity_context` | エンティティ単位のコンテキストバンドル（model, routes, pages, linked docs） |
| `guren_check` | route↔controller↔page の整合性・docリンク・spec鮮度の検証 |
| `guren_list_models` | モデル一覧（リレーション、soft deletes、auth trait含む） |
| `guren_generate_guidelines` | プロジェクト固有コーディング規約の自動生成 |
| `guren_doctor` | プロジェクト健全性チェック + 次のアクション提案 |
| `guren_make_feature` | CRUD 一括スキャフォールド |
| `guren_make_component` | 個別コンポーネント生成 |
| `guren_codegen` | 型マニフェスト生成（routes.gen.ts, pages.gen.ts等） |

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
export class Post extends defineModel(posts) {
  static fillable = ['title', 'body', 'authorId']
}
```

- Models: `await Post.findOrFail(id)` throws a 404; `Post.where(...)` starts a query
  builder chain. Full API in `.claude/rules/orm-models.md`.
- Attaching a Zod schema to a route both validates the request automatically and
  feeds `bunx guren codegen` typed manifests. Details in `.claude/rules/routes-codegen.md`.
- Middleware: `defineMiddleware(async (c, next) => { ... })` from `@guren/core`;
  register aliases via `router.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))`.

## Testing

Uses `bun:test` + `@guren/testing`. Requests run in-process via `app.fetch()` — no server needed.

```typescript
import { TestApp } from '@guren/testing'

const app = await TestApp.create()
await app.get('/posts').assertOk()
await app.actingAs(user).json().post('/posts', { title: 'Hi' }).assertCreated()
```

Full client and assertion reference: `.claude/rules/testing.md`.

## Key Files

| Path | Purpose |
|------|---------|
| `bin/serve.ts` | Server entry point |
| `config/` | Application configuration |
| `db/schema.ts` | Database table definitions |
| `routes/web.ts` | Web route definitions |
| `app/Providers/` | Service providers |
| `resources/js/pages/` | React page components |
| `.claude/rules/` | Glob-scoped API rules (auto-loaded per edited path) |

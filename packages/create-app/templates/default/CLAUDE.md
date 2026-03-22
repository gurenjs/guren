# __APP_TITLE__

## Overview

A fullstack TypeScript application built with the Guren framework (Laravel-inspired, running on Bun).

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

# Database
bun run db:migrate
bun run db:seed

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
| `guren_check` | route↔controller↔page の整合性検証 |
| `guren_list_models` | モデル一覧（リレーション、soft deletes、auth trait含む） |
| `guren_generate_guidelines` | プロジェクト固有コーディング規約の自動生成 |
| `guren_doctor` | プロジェクト健全性チェック + 次のアクション提案 |
| `guren_make_feature` | CRUD 一括スキャフォールド |
| `guren_make_component` | 個別コンポーネント生成 |
| `guren_codegen` | 型マニフェスト生成（routes.gen.ts, pages.gen.ts等） |

## Architecture Patterns

### Controllers
```typescript
import { Controller } from '@guren/core'
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
    const result = await Post.paginate({ page: 1, perPage: 15 })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })
    return this.inertia(appPages.posts.index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: paginator,
    })
  }

  async show() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    return this.inertia(appPages.posts.show, { post: new PostResource(post).toJSON() })
  }

  async store() {
    const data = await this.validateBody(CreatePostSchema)
    const user = await this.auth.userOrFail()
    const post = await Post.create({ ...data, authorId: user.id })
    return this.redirect('/posts')
  }
}
```

**Validation helpers** (accepts any Zod-like schema with `safeParse`):
- `this.validateBody(schema)` — parse request body, throw 422 on failure
- `this.validateQuery(schema)` — parse query parameters
- `this.validateParams(schema)` — parse route parameters

### Models
```typescript
import { Model } from '@guren/orm'
import { posts } from '@/db/schema'

export class Post extends Model<typeof posts> {
  static table = posts
}

// Usage
const post = await Post.find(1)          // returns null if not found
const post = await Post.findOrFail(1)    // throws ModelNotFoundException (404)
const all = await Post.where('published', true).get()
```

### Routes
```typescript
import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', PostController.index)
  router.post('/posts', PostController.store)
  router.resource('/posts', PostController)

  router.middleware('auth').group((group) => {
    group.get('/dashboard', DashboardController.index)
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

## Key Files

| Path | Purpose |
|------|---------|
| `bin/serve.ts` | Server entry point |
| `config/` | Application configuration |
| `db/schema.ts` | Database table definitions |
| `routes/web.ts` | Web route definitions |
| `app/Providers/` | Service providers |
| `resources/js/pages/` | React page components |

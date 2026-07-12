# __APP_TITLE__

## Overview

A fullstack TypeScript application built with the Guren framework (Laravel-inspired, running on Bun).

## AI Agents: Start Here

Before exploring `node_modules`, use the built-in introspection commands:

```bash
bunx guren context     # project map: models, routes, controllers, pages (add --json for JSON)
bunx guren check       # validate route ↔ controller ↔ page consistency — run after changes
bunx guren codegen     # regenerate .guren/*.gen.ts typed manifests (also runs via `bun run dev`)
```

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
    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: paginator,
    })
  }

  async show() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
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
- `this.validateBody<T>(schema): Promise<T>` — parse request body
- `this.validateQuery<T>(schema): T` — parse query parameters
- `this.validateParams<T>(schema): T` — parse route parameters

All throw `ValidationException` on failure, rendered as HTTP 422 with `{ message, errors: Record<string, string[]> }`. Non-throwing variants (`validateBodySafe` etc.) return `{ success: true, data } | { success: false, errors }`.

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

**Where clauses** — object form or `(field, operator, value)` form:

```typescript
await Post.where({ status: 'active', authorId: 1 }).get()  // AND; array value = IN
await Post.where({ id: [1, 2, 3] }).get()                  // WHERE id IN (1, 2, 3)
await Post.where('views', '>', 100).orWhere('featured', true).get()
```

Operators: `=` `!=` `>` `<` `>=` `<=` `like` `in` `not in` `is null` `is not null`.
Chain: `where` / `orWhere` / `whereNull` / `whereNotNull` / `orderBy(field, 'asc'|'desc')` / `limit` / `offset` / `with` — finish with `get()` / `first()` / `firstOrFail()` / `count()` / `paginate(page?, perPage?)` / `update(data)` / `delete()`.

**Relationships** — declare on the class, eager-load with `with()`:

```typescript
User.hasMany('posts', () => import('./Post.js').then((m) => m.Post), 'authorId', 'id')
Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
// belongsToMany(name, related, pivotTable, foreignPivotKey, relatedPivotKey, parentKey = 'id', relatedKey = 'id')
Post.belongsToMany('tags', () => import('./Tag.js').then((m) => m.Tag), postTags, 'postId', 'tagId')

await Post.with('tags')            // eager load; nested via dot: with('author.posts')
await Post.findWith(1, 'tags')     // single record + relations
await Post.withCount('tags')       // adds tagsCount, no rows loaded
```

Also: `hasOne`, `hasManyThrough`, `morphMany`/`morphTo`, `withPaginate`.

**There are no `attach`/`detach`/`sync` pivot helpers.** Manage pivot rows with a model on the pivot table:

```typescript
export class PostTag extends Model<typeof postTags> { static table = postTags }
await PostTag.create({ postId, tagId })   // attach
await PostTag.delete({ postId, tagId })   // detach
// sync: PostTag.delete({ postId }) then re-create the desired set
```

**There is no `firstOrCreate` / `updateOrCreate`.** Hand-roll the pattern:

```typescript
const existing = await Tag.first({ name })  // first(where?) → record | null
const tag = existing ?? await Tag.create({ name })
```

For concurrency safety, add a unique index and catch the constraint error, or wrap in `Tag.transaction(async (trx) => ...)`.

**Mass assignment** — `create()` / `update()` filter their input:

```typescript
export class Post extends Model<typeof posts> {
  static table = posts
  static fillable = ['title', 'body', 'authorId']  // whitelist — always set on user-input models
}
```

- With `fillable` set, unlisted input keys **throw `MassAssignmentException`** (`static strictFillable = false` restores silent discarding)
- Without `fillable`, keys in `guarded` (default `['id']`) are silently stripped
- `forceCreate()` / `forceUpdate()` bypass filtering — trusted server-side data only

### Routes
```typescript
import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index']).name('posts.index')
  // Attach the Zod body schema so codegen can extract typed ApiRoutes entries
  router.post('/posts', { name: 'posts.store', body: CreatePostSchema }, [PostController, 'store'])

  router.middleware('auth').group((group) => {
    group.get('/dashboard', [DashboardController, 'index'])
  })
}
```

### Codegen: which Zod constructs survive type extraction

`bunx guren codegen` walks route schemas at runtime (Zod v3 and v4 both supported) and emits `body` types into `ApiRoutes` (`.guren/api-client.gen.ts`):

- **Typed**: primitives (`string`/`number`/`boolean`/`bigint`/`date`), `literal`, `enum`, `array`, nested `object`, `union` / `discriminatedUnion`, `intersection`, `record`, `nullable` (`| null`)
- **Unwrapped transparently**: `.optional()` and `.default()` (field becomes `key?:`), `.catch()`, `.readonly()`, `.brand()`, `.lazy()`
- **Validation checks don't change the type**: `.min()`, `.max()`, `.trim()`, `.email()`, regex etc. stay `string`; `z.coerce.number()` is `number`
- **Input side only**: `.transform()` / `.refine()` chains extract the schema's *input* type — transform output types are NOT reflected
- **Degrades**: `tuple` → `unknown[]`, `z.nativeEnum()` → `string | number`, unrecognized constructs → `unknown`

So `z.string().trim().min(1).optional().default('x')` survives as `key?: string`. If a generated type comes out as `unknown`, simplify the construct rather than reading `node_modules`.

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

## Testing

Uses `bun:test` + `@guren/testing`. Requests run in-process via `app.fetch()` — no server needed.

```typescript
import { test } from 'bun:test'
import { TestApp } from '@guren/testing'

test('posts endpoints', async () => {
  const app = await TestApp.create()
  await app.get('/posts').assertOk().assertJsonCount(3, 'data')
  await app.actingAs(user).json().post('/posts', { title: 'Hi' }).assertCreated()
  await app.get('/posts/999').assertNotFound()
})
```

- **Client**: `get(path)` / `post(path, body?)` / `put` / `patch` / `delete`, `actingAs(user)`, `json()`, `withHeader(name, value)` / `withHeaders(obj)`, `await app.withCsrf()` (primes session + XSRF cookies so mutating requests pass CSRF)
- **Chainable assertions**: `assertStatus(code)`, `assertOk`, `assertCreated`, `assertNoContent`, `assertRedirect(url?)`, `assertNotFound`, `assertForbidden`, `assertUnauthorized`, `assertUnprocessable`, `assertJson(obj)`, `assertJsonCount(n, key?)`, `assertJsonStructure(keys)`, `assertJsonPath(path, value)`, `assertInertia(component, props?)`, `assertCookie(name, value?)`, `assertCookieMissing(name)`, `assertHeader(name, value?)`, `assertHeaderMissing(name)`

## Key Files

| Path | Purpose |
|------|---------|
| `bin/serve.ts` | Server entry point |
| `config/` | Application configuration |
| `db/schema.ts` | Database table definitions |
| `routes/web.ts` | Web route definitions |
| `app/Providers/` | Service providers |
| `resources/js/pages/` | React page components |

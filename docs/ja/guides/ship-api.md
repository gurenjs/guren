# API を構築して公開する

このガイドでは、Guren で JSON API を構築して公開するまでの手順を説明します。API 専用プロジェクトの作成、データベーススキーマの定義、バリデーション付きコントローラーの作成、エンドポイントのテストまでをカバーします。

> [!NOTE]
> コントローラー、バリデーション、ミドルウェアの詳細は[コントローラー](./controllers.md)と[バリデーション](./validation.md)を参照してください。

## 前提条件

- **Bun 1.1 以降**
- **Docker Desktop (Compose v2)** — Postgres 用

## 1. API プロジェクトを作成する

`api` ブループリントを指定すると、Inertia やフロントエンドツールを省いた軽量な API スターターが生成されます:

```bash
bunx create-guren-app my-api --blueprint api --db postgres
cd my-api
bun install
```

## 2. データベースを起動する

```bash
bun run db:up
```

## 3. スキーマを定義する

`db/schema.ts` を開いてテーブルを追加します。以下はシンプルな `tasks` テーブルの例です:

```typescript
import { pgTable, serial, text, boolean, timestamp } from 'drizzle-orm/pg-core'

export const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  completed: boolean('completed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
```

マイグレーションを生成して実行します:

```bash
bunx guren db:migrate:generate create_tasks
bunx guren db:migrate
```

## 4. モデルを作成する

```bash
bunx guren make:model Task
```

スキーマと関連付けます:

```typescript
import { defineModel } from '@guren/core'
import { tasks } from '@/db/schema'

export class Task extends defineModel(tasks) {}
```

## 5. コントローラーを作成する

```bash
bunx guren make:controller TaskController
```

Zod バリデーション付きの CRUD アクションを追加します:

```typescript
import { Controller } from '@guren/core'
import { z } from 'zod'
import { Task } from '@/app/Models/Task'

const CreateTaskSchema = z.object({
  title: z.string().min(1).max(255),
})

const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  completed: z.boolean().optional(),
})

const TaskIdSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export class TaskController extends Controller {
  async index() {
    const tasks = await Task.all()
    return this.json({ tasks })
  }

  async show() {
    const { id } = this.validateParams(TaskIdSchema)
    const task = await Task.findOrFail(id)
    return this.json({ task })
  }

  async store() {
    const data = await this.validateBody(CreateTaskSchema)
    const task = await Task.create(data)
    return this.json({ task }, 201)
  }

  async update() {
    const { id } = this.validateParams(TaskIdSchema)
    const data = await this.validateBody(UpdateTaskSchema)
    const task = await Task.findOrFail(id)
    await task.update(data)
    return this.json({ task })
  }

  async destroy() {
    const { id } = this.validateParams(TaskIdSchema)
    const task = await Task.findOrFail(id)
    await task.delete()
    return this.json({ message: 'Deleted' })
  }
}
```

## 6. ルートを登録する

`routes/web.ts`(API 専用プロジェクトでは `routes/api.ts`)を開いて追加します:

```typescript
import { Router } from '@guren/core'
import { TaskController } from '@/app/Http/Controllers/TaskController'

export function registerApiRoutes(router: Router): void {
  router.get('/api/tasks', [TaskController, 'index']).name('tasks.index')
  router.get('/api/tasks/:id', [TaskController, 'show']).name('tasks.show')
  router.post('/api/tasks', [TaskController, 'store']).name('tasks.store')
  router.put('/api/tasks/:id', [TaskController, 'update']).name('tasks.update')
  router.delete('/api/tasks/:id', [TaskController, 'destroy']).name('tasks.destroy')
}
```

## 7. 型マニフェストを生成する

```bash
bun run codegen
```

ここでは `.guren/pages.gen.ts` は生成されません。このマニフェストは
`@guren/inertia-client` を import しますが、API 専用アプリはそのパッケージを
インストールしていない一方で、`tsconfig.json` は `.guren/` 配下をすべて型検査
します。生成してしまうと `bun run typecheck` が 1 行目で落ちます。

この判断はスキャフォルダーではなく codegen が持っています。`resources/js/pages`
にページコンポーネントが現れたとき — 手でコピーした場合でも、チェックアウトで
入ってきた場合でも — codegen はマニフェストを書かず、その理由を出力します:

```
[warn] 1 page component under resources/js/pages, but this app has no
@guren/inertia-client dependency and no routes/web.ts, so codegen writes no
.guren/pages.gen.ts
```

`guren check` と `guren doctor` も同じ状態を報告します。アプリがこの形になる前に
生成された `.guren/pages.gen.ts` がディスクに残っている場合はより強く警告します。
`tsc` を落とすのはこの残骸なので、原因となったページコンポーネントを削除した後でも
報告され、`guren check --ci` はこの状態で失敗します（未使用のページコンポーネント
だけでは CI は失敗しません）。codegen はそのファイルを削除しません。本当に必要な
ファイルを消してしまうと、型エラーが原因不明の不具合に変わるからです。不要なら
自分で削除し、Inertia のページを描画するアプリであれば `@guren/inertia-client` の
依存と `routes/web.ts` を追加してください。

## 8. エンドポイントをテストする

開発サーバーを起動します:

```bash
bun run dev
```

`curl` や任意の HTTP クライアントでリクエストを送ります:

```bash
# タスクを作成
curl -X POST http://localhost:3333/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "ドキュメントを書く"}'

# タスク一覧を取得
curl http://localhost:3333/api/tasks

# タスクを取得
curl http://localhost:3333/api/tasks/1

# タスクを更新
curl -X PUT http://localhost:3333/api/tasks/1 \
  -H "Content-Type: application/json" \
  -d '{"completed": true}'

# タスクを削除
curl -X DELETE http://localhost:3333/api/tasks/1
```

## 9. API トークン認証を追加する

認証が必要なルートにはAPIトークンを配線します。これにスキャフォールドはありません
— `guren add auth` は Inertia のサインイン画面を生成するため、API 専用アプリでは
実行を拒否します。ミドルウェアは自分で用意してください:

```typescript
import { createBearerTokenMiddleware, DatabaseApiTokenStore } from '@guren/core'
import { apiTokens } from '@/db/schema'

const store = new DatabaseApiTokenStore(apiTokens)

export const requireApiToken = createBearerTokenMiddleware({ store })
```

これで変更系のルートを保護します:

```typescript
router.middleware(requireApiToken).group((auth) => {
  auth.post('/api/tasks', [TaskController, 'store']).name('tasks.store')
  auth.put('/api/tasks/:id', [TaskController, 'update']).name('tasks.update')
  auth.delete('/api/tasks/:id', [TaskController, 'destroy']).name('tasks.destroy')
})
```

`api_tokens` テーブル、`createApiToken` でのトークン発行、abilities によるスコープ
制限については[APIトークンガイド](./api-tokens.md)を参照してください。

クライアントは `Authorization` ヘッダーにトークンを含めます:

```bash
curl -X POST http://localhost:3333/api/tasks \
  -H "Authorization: Bearer your-api-token" \
  -H "Content-Type: application/json" \
  -d '{"title": "認証済みタスク"}'
```

## 次のステップ

- [レート制限](./rate-limiting.md) — エンドポイントを不正利用から保護する
- [API リソース](./api-resources.md) — リソースクラスで JSON レスポンスを整形する
- [バリデーション](./validation.md) — 高度なバリデーションパターン
- [エラーハンドリング](./error-handling.md) — API エラーレスポンスをカスタマイズする

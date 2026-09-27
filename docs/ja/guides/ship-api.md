# API を構築して公開する

このガイドでは、Guren で JSON API を作って公開するまでの手順を説明します。API 専用プロジェクトを作成し、データベースのスキーマを定義して、バリデーション付きのコントローラーを書き、最後にエンドポイントを試します。

> [!NOTE]
> コントローラー、バリデーション、ミドルウェアの詳細は[コントローラー](./controllers.md)と[バリデーション](./validation.md)を参照してください。

## 前提条件

- **Bun 1.4.2**
- **Docker Desktop (Compose v2)**: Postgres 用

## 1. API プロジェクトを作成する

`api` ブループリントを指定すると、Inertia やフロントエンドのツールを含まない、軽量な API 用の雛形ができます。

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

`db/schema.ts` を開き、テーブルを追加します。ここでは簡単な `tasks` テーブルを例にします。

```typescript
import { pgTable, serial, text, boolean, timestamp } from '@guren/orm/drizzle/pg'

export const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  completed: boolean('completed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
```

マイグレーションを生成し、実行します。

```bash
bunx guren make:migration --name create_tasks
bunx guren db:migrate
```

## 4. モデルを作成する

```bash
bunx guren make:model Task
```

生成されたモデルをスキーマのテーブルに結びつけます。

```typescript
import { defineModel } from '@guren/core'
import { tasks } from '@/db/schema'

export class Task extends defineModel(tasks) {}
```

## 5. コントローラーを作成する

```bash
bunx guren make:controller TaskController
```

Zod でバリデーションする CRUD アクションを追加します。

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

`routes/web.ts`（API 専用プロジェクトでは `routes/api.ts`）を開き、ルートを追加します。

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

API 専用アプリでは、ここで `.guren/pages.gen.ts` は生成されません。このマニフェストは `@guren/inertia-client` を import しますが、API 専用アプリにはそのパッケージが入っていないからです。一方で `tsconfig.json` は `.guren/` 配下をすべて型検査するので、もし生成すると `bun run typecheck` が 1 行目で失敗します。

生成するかどうかは codegen が実行のたびに判断し、雛形を生成するコマンドは関与しません。`resources/js/pages` にページコンポーネントが現れた場合は、手でコピーしたものでもチェックアウトで入ってきたものでも、codegen はマニフェストを書かずに理由を出力します。

```
[warn] 1 page component under resources/js/pages, but this app has no
@guren/inertia-client dependency and no routes/web.ts, so codegen writes no
.guren/pages.gen.ts
```

`guren check` と `guren doctor` も同じ状態を報告します。アプリがこの構成になる前に生成された `.guren/pages.gen.ts` がディスクに残っていると、警告はより強くなります。`tsc` を失敗させるのはこの残ったファイルなので、原因のページコンポーネントを削除した後も報告は続き、この状態では `guren check --ci` が失敗します（使われていないページコンポーネントがあるだけなら、CI は失敗しません）。

codegen はこのファイルを削除しません。本当に必要なファイルを消してしまうと、型エラーが原因のわからない不具合に変わってしまうからです。不要なら手で削除してください。Inertia のページを描画するアプリにしたい場合は、`@guren/inertia-client` の依存と `routes/web.ts` を追加します。

## 8. エンドポイントをテストする

開発サーバーを起動します。

```bash
bun run dev
```

`curl` などの HTTP クライアントでリクエストを送ってみます。

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

認証が必要なルートには API トークンの確認を組み込みます。この部分を生成するコマンドはありません。`guren add auth` は Inertia のサインイン画面を作るコマンドなので、API 専用アプリでは実行を拒否します。ミドルウェアは次のように手で用意してください。

```typescript
import { createBearerTokenMiddleware, DatabaseApiTokenStore } from '@guren/core'
import { apiTokens } from '@/db/schema'

const store = new DatabaseApiTokenStore(apiTokens)

export const requireApiToken = createBearerTokenMiddleware({ store })
```

このミドルウェアで、データを変更するルートを保護します。

```typescript
router.middleware(requireApiToken).group((auth) => {
  auth.post('/api/tasks', [TaskController, 'store']).name('tasks.store')
  auth.put('/api/tasks/:id', [TaskController, 'update']).name('tasks.update')
  auth.delete('/api/tasks/:id', [TaskController, 'destroy']).name('tasks.destroy')
})
```

`api_tokens` テーブルの用意、`createApiToken` によるトークンの発行、abilities による権限範囲の制限は、[API トークンガイド](./api-tokens.md)で説明しています。

クライアントは、トークンを `Authorization` ヘッダーに入れて送ります。

```bash
curl -X POST http://localhost:3333/api/tasks \
  -H "Authorization: Bearer your-api-token" \
  -H "Content-Type: application/json" \
  -d '{"title": "認証済みタスク"}'
```

## 次のステップ

- [レート制限](./rate-limiting.md): エンドポイントを不正利用から守る
- [API リソース](./api-resources.md): リソースクラスで JSON レスポンスを整形する
- [バリデーション](./validation.md): 込み入ったバリデーションのパターン
- [エラーハンドリング](./error-handling.md): API のエラーレスポンスをカスタマイズする

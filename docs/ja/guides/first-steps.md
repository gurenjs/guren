# 10分で最初の機能を作る

タスクトラッカーを作ります：タスクの作成、一覧表示、完了マーク。このチュートリアルが終わる頃には、Guren の MVC ループがデータベースからブラウザまでどう動くかを理解できます。

## 作るもの

タスクを入力して Enter を押すとリストに表示されるシンプルなページです。各タスクにはチェックボックスがあり、完了マークを付けられます。シンプルですが、フレームワークのすべてのレイヤーに触れます：スキーマ、モデル、コントローラー、ルート、React ページ。

## 1. プロジェクトを生成する

```bash
bunx create-guren-app tasks-app
cd tasks-app
bun install
```

プロンプトが出たら **SSR** モードを選択してください。生成されたプロジェクトには、Bun サーバー、Vite によるフロントエンドビルド、PostgreSQL 対応の Drizzle セットアップが含まれています。

> [!NOTE]
> PostgreSQL がローカルで動いている必要があります。`bun run db:up` で Docker コンテナを起動するか、`.env` の `DATABASE_URL` を自分のインスタンスに設定してください。

## 2. スキーマを定義する

`db/schema.ts` を開いて `tasks` テーブルを追加します：

```ts
import { pgTable, serial, text, boolean, timestamp } from 'drizzle-orm/pg-core'

export const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  completed: boolean('completed').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
```

マイグレーションを生成して実行します：

```bash
bunx guren db:migrate
```

## 3. モデルを作成する

```bash
bunx guren make:model Task
```

生成された `app/Models/Task.ts` を開いてスキーマとリンクします：

```ts
import { Model } from '@guren/orm'
import { tasks } from '@/db/schema'

export type TaskRecord = typeof tasks.$inferSelect

export class Task extends Model<TaskRecord> {
  static override table = tasks
  static override readonly recordType = {} as TaskRecord
}
```

これだけでデータ層は完成です。`Task` には `find()`、`create()`、`where()`、`update()`、`delete()`、`paginate()`、そして流暢な QueryBuilder が備わっています — すべて Drizzle スキーマから型安全に。

## 4. コントローラーを作成する

```bash
bunx guren make:controller TaskController
```

`app/Http/Controllers/TaskController.ts` を開いて内容を置き換えます：

```ts
import { Controller } from '@guren/server'
import { Task } from '@/app/Models/Task'

export default class TaskController extends Controller {
  async index() {
    const tasks = await Task.where('completed', false)
      .orderBy('createdAt', 'desc')
      .get()

    const completed = await Task.where('completed', true)
      .orderBy('createdAt', 'desc')
      .get()

    return this.inertia('Tasks/Index', { tasks, completed })
  }

  async store() {
    const title = await this.input<string>('title')

    if (!title || title.trim().length === 0) {
      return this.redirect('/tasks')
    }

    await Task.create({ title: title.trim() })
    return this.redirect('/tasks')
  }

  async update() {
    const id = Number(this.request.param('id'))
    const completed = await this.input<boolean>('completed')

    await Task.update({ id }, { completed: completed ?? true })
    return this.redirect('/tasks')
  }
}
```

3つのメソッド、それぞれ数行。`this.input()` でリクエストボディを読み、`this.inertia()` で React ページを型付き props と共にレンダリングし、`this.redirect()` でユーザーを戻します。

## 5. ルートを定義する

`routes/web.ts` に追加します：

```ts
import TaskController from '@/app/Http/Controllers/TaskController'

Route.get('/tasks', [TaskController, 'index']).name('tasks.index')
Route.post('/tasks', [TaskController, 'store']).name('tasks.store')
Route.put('/tasks/:id', [TaskController, 'update']).name('tasks.update')
```

3つのルート、3つのコントローラーメソッド。`[Controller, 'method']` のタプル構文でメソッド名の自動補完が効きます。

## 6. ページを作成する

`resources/js/pages/Tasks/Index.tsx` を作成します：

```tsx
import { useForm } from '@inertiajs/react'

type Task = {
  id: number
  title: string
  completed: boolean
  createdAt: string
}

type Props = {
  tasks: Task[]
  completed: Task[]
}

export default function TasksIndex({ tasks, completed }: Props) {
  const form = useForm({ title: '' })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    form.post('/tasks', { onSuccess: () => form.reset() })
  }

  function toggleTask(task: Task) {
    form.put(`/tasks/${task.id}`, {
      data: { completed: !task.completed },
    })
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <h1 className="text-2xl font-bold">Tasks</h1>

      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <input
          type="text"
          value={form.data.title}
          onChange={(e) => form.setData('title', e.target.value)}
          placeholder="何をする？"
          className="flex-1 rounded border px-3 py-2"
        />
        <button
          type="submit"
          disabled={form.processing}
          className="rounded bg-blue-600 px-4 py-2 text-white"
        >
          追加
        </button>
      </form>

      <ul className="mt-6 space-y-2">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-center gap-3">
            <input
              type="checkbox"
              onChange={() => toggleTask(task)}
              className="h-4 w-4"
            />
            <span>{task.title}</span>
          </li>
        ))}
      </ul>

      {completed.length > 0 && (
        <>
          <h2 className="mt-8 text-lg font-semibold text-gray-500">
            完了済み ({completed.length})
          </h2>
          <ul className="mt-2 space-y-2">
            {completed.map((task) => (
              <li key={task.id} className="flex items-center gap-3 text-gray-400">
                <input
                  type="checkbox"
                  checked
                  onChange={() => toggleTask(task)}
                  className="h-4 w-4"
                />
                <span className="line-through">{task.title}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  )
}
```

Inertia がサーバーとクライアントの通信を処理します。fetch も API ルートもローディング状態も不要です。フォームを送信すると、サーバーの最新データでページが更新されます。

## 7. 実行する

```bash
bun run dev
```

`http://localhost:3333/tasks` を開いてください。タスクを入力して **追加** をクリックすると表示されます。チェックボックスを押すと完了セクションに移動します。

## 何が起きたのか？

いま作ったフローはこうなっています：

1. **ブラウザ** が `GET /tasks` をリクエスト
2. **ルート** が URL を `TaskController.index` にマッピング
3. **コントローラー** が **モデル** を通してタスクを取得し、`this.inertia()` を呼び出す
4. **Inertia** がデータを props として React ページをレンダリング
5. ユーザーがフォームを送信 — Inertia がフルページリロードなしで `POST /tasks` を送信
6. **コントローラー** がタスクを作成しリダイレクト
7. Inertia がリダイレクトをたどり、最新の props を取得してページを更新

これが Guren で何を作るときでも基本となるコアループです。このタスクリストと同じパターンが、認証、バリデーション、ファイルアップロード、バックグラウンドジョブを備えた本格的なアプリケーションにもスケールします。

## 次のステップ

動く機能ができました。ここからさらに深く学びましょう：

- **[ルーティングガイド](./routing.md)** — ミドルウェアグループ、リソースルート、ルートモデルバインディング。
- **[コントローラーガイド](./controllers.md)** — FormRequest によるバリデーション、レスポンスヘルパー、依存性注入。
- **[データベースガイド](./database.md)** — リレーション、スコープ、ページネーション、フック、シーダー。
- **[フロントエンドガイド](./frontend.md)** — レイアウト、共有 props、SSR、アセット管理。
- **[認証ガイド](./authentication.md)** — ログイン追加とルートの保護。
- **[テスティングガイド](./testing.md)** — いま作ったものすべてにテストを書く。

# Guren を一目で

Laravel のような書き心地の、フルスタック TypeScript フレームワーク — Bun で動きます。

## まずはコードを見てください

ルート、コントローラー、型付きレスポンス — たった数行で書けます。

```ts
// routes/web.ts
import { Router } from '@guren/core'
import TaskController from '@/app/Http/Controllers/TaskController'
import DashboardController from '@/app/Http/Controllers/DashboardController'

export function registerWebRoutes(router: Router): void {
  router.get('/tasks', [TaskController, 'index'])
  router.post('/tasks', [TaskController, 'store'])

  router.middleware('auth').group((auth) => {
    auth.get('/dashboard', [DashboardController, 'index'])
  })
}
```

```ts
// app/Http/Controllers/TaskController.ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { Task } from '@/app/Models/Task'
import { TaskResource, type TaskResourceData } from '@/app/Http/Resources/TaskResource'
import { CreateTaskSchema, ListTasksQuerySchema } from '@/app/Http/Validators/TaskValidator'
import { pages } from '@/.guren/pages.gen'

type TasksIndexProps = PaginatedPageProps<TaskResourceData>

export default class TaskController extends Controller {
  async index() {
    const { page } = this.validateQuery(ListTasksQuerySchema)
    const result = await Task.paginate({ page, perPage: 20, orderBy: ['createdAt', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/tasks' })

    return this.inertia(pages.tasks.Index, {
      data: result.data.map((task) => new TaskResource(task).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies TasksIndexProps)
  }

  async store() {
    const data = await this.validateBody(CreateTaskSchema)
    const task = await Task.create(data)
    return this.redirect(`/tasks/${task?.id ?? ''}`)
  }
}
```

React ページにはコントローラーから型付き props がそのまま渡ります — API レイヤーの手書きは不要です。

```tsx
// resources/js/pages/tasks/Index.tsx
import type { PageProps } from '@guren/inertia-client/contracts'
import { pages } from '@/.guren/pages.gen'

type Props = PageProps<typeof pages.tasks.Index>

export default function TasksIndex({ data, pagination }: Props) {
  return (
    <section>
      <ul>
        {data.map((task) => (
          <li key={task.id}>{task.title}</li>
        ))}
      </ul>
      <p>{pagination.meta.total} tasks</p>
    </section>
  )
}
```

テストは自然な文章のように読めます。

```ts
const app = await TestApp.create({ boot })

await app.get('/tasks').assertOk().assertJsonCount(3, 'tasks')
await app.post('/tasks', { title: 'Ship it' }).assertRedirect('/tasks')
await app.actingAs(user).get('/dashboard').assertOk()
```

## Guren の特徴

**Bun ネイティブ。** Guren は Bun ランタイム上で Hono を HTTP レイヤーとして動作します。Node.js の互換レイヤーを経由せず、Bun 上で直接動作します。Bun の高速起動、ネイティブ TypeScript 実行、組み込みテストランナーをそのまま活用できます。

**TypeScript で Laravel の開発体験。** Laravel を使ったことがあれば、リソースルーティング、`Controller` と `this.inertia()`、`Model.where().orderBy().get()` といったパターンにはすぐ馴染めます。使ったことがなくても大丈夫です — API は「やりたいこと」がそのまま読めるように設計されています。

**エンドツーエンドの型安全。** Drizzle のスキーマ型が Model に流れ、Controller を通って、React ページの props まで到達します。カラム名を変えると TypeScript がデータベースからブラウザまで、更新が必要な箇所をすべてキャッチします。

**必要な機能を標準搭載。ただし使用は任意。** 認証、バリデーション、キャッシュ、キュー、メール、イベント、ブロードキャスト、スケジューリング — 必要なときにすべて揃っています。各サブシステムは ServiceProvider によるオプトイン方式なので、使うものだけをロードします。

**設定より規約。** `bunx guren add auth` や `bunx guren add resource posts` で feature 単位に生成できます。CLI が正しい場所に正しい構造でファイルを作るので、フォルダ構成の議論ではなく機能開発に時間を使えます。

**グローバル状態よりアプリ単位。** 生成されたアプリは route registrar を `createApp({ routes })` に渡すため、複数アプリやテスト間でルート状態が混線しません。

## はじめよう

```bash
bunx create-guren-app my-app --mode ssr
cd my-app
bun install
bunx guren add auth
bunx guren add resource posts --fields "title:string,body:text"
bun run codegen
bun run db:migrate && bun run db:seed
bun run typecheck && bun run build
bun run dev        # http://localhost:3333 にアクセス
```

## さらに詳しく

Guren が初めての方は、この順番で進めてください。

1. **[はじめの一歩](./first-steps.md)** — 10分で動く機能を作ります。
2. **[環境構築](./getting-started.md)** — 環境設定とデータベースの準備。
3. **[ルーティングガイド](./routing.md)** — グループ、ミドルウェア、リソースルート。
4. **[コントローラーガイド](./controllers.md)** — リクエスト処理、入力ヘルパー、バリデーション。
5. **[データベースガイド](./database.md)** — Drizzle スキーマ、マイグレーション、QueryBuilder、リレーション。
6. **[フロントエンドガイド](./frontend.md)** — Inertia.js と React ページ、SSR。
7. **[テスティングガイド](./testing.md)** — TestApp、アサーション、テストユーティリティ。

CLI コマンドの詳細は [CLI リファレンス](./cli.md) を参照してください。用語がわからないときは [用語集](./glossary.md) をチェックしてください。

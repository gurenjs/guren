# Guren を一目で

Laravel のような書き心地の、フルスタック TypeScript フレームワーク — Bun で動きます。

## まずはコードを見てください

ルート、コントローラー、型付きレスポンス — これだけの行数で書けます。

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

React ページはコントローラーから型付きの props を直接受け取ります。API レイヤーを手書きする必要はありません。

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

テストは英語の文章のように読めます。

```ts
const app = await TestApp.create({ boot })

await app.get('/tasks').assertOk().assertJsonCount(3, 'tasks')
await app.post('/tasks', { title: 'Ship it' }).assertRedirect('/tasks')
await app.actingAs(user).get('/dashboard').assertOk()
```

## Guren の特長

**最初から Bun ネイティブ。** Guren は Bun ランタイム上で動作し、HTTP レイヤーには Hono を採用しています。Node.js の互換シムは一切ありません。Bun の高速な起動、TypeScript のネイティブ実行、組み込みテストランナーをそのまま活用できます。

**Laravel の開発体験を、TypeScript で。** Laravel の経験があれば、リソースルーティング、`this.inertia()` を備えた `Controller` 基底クラス、`Model.where().orderBy().get()` といったパターンがすぐに馴染むはずです。経験がなくても心配いりません — API は「読めば何をするか分かる」設計になっています。

**エンドツーエンドの型安全。** Drizzle スキーマの型がモデルへ、コントローラーを通って React ページの props へと流れます。カラム名を変更すれば、データベースからブラウザまで、更新が必要なすべての箇所を TypeScript が検出します。

**コードとつながり続けるプロジェクト知識。** Guren はアーキテクチャ上の意思決定と生成スペックを、それらが統べるエンティティやコードパスに結び付け、関係を検証し、開発中はコーパス全体をインタラクティブな Docs Graph として表示します。ワークフロー全体は [スペックアンカード開発](./spec-anchored.md) を参照してください。

**バッテリー同梱、ただし強制はしない。** 認証、バリデーション、キャッシュ、キュー、メール、イベント、ブロードキャスト、スケジューリング — 必要になったときにすべて揃っています。各サブシステムは ServiceProvider によるオプトイン方式なので、使うものだけを読み込みます。

**設定より規約。** `bunx guren add auth` や `bunx guren add resource posts` で機能一式を生成できます。CLI が適切な場所に適切な構造でファイルを配置するので、フォルダ構成の議論ではなく機能開発に時間を使えます。

**グローバル状態ではなく registrar 方式のルーター。** 生成されるアプリはルート登録用の registrar を export し、`createApp({ routes })` に渡します。これによりルーティングは各アプリケーションインスタンスにスコープされます。

Hono・Next.js・Laravel との踏み込んだ比較と、AI コーディングエージェント向けの設計思想については [Why Guren](./why-guren.md) を参照してください。

## はじめる

コマンドは 4 つだけ。Docker もデータベースサーバーも不要 — 新規アプリは最初から SQLite で動きます。

```bash
bunx create-guren-app my-app   # scaffold — accept the default prompts (SSR, SQLite)
cd my-app
bun install                    # usually a no-op: the scaffolder installs for you
bun run dev                    # start the dev server
```

`http://localhost:3333` を開けば、Guren アプリが動いています。

## さらに学ぶ

次の順番で進めるのがおすすめです。

1. **[クイックスタート](./getting-started.md)** — プロジェクトを雛形生成し、5 分程度で動かします。
2. **[Guren チュートリアル](../tutorials/00-overview.md)**: **初めての方に最もおすすめ。** 空のディレクトリからデプロイまでブログを作る、全 14 章のハンズオンコースです。各章はひとスライスをコーディングエージェントに委ね、その結果をテストと `guren gate` で判定します。完走すれば、すべてのコアコンセプトに触れたうえで、次のスライスの委ね方も分かっています。
3. **トピック別ガイド** — 全体像を掴んだあとの深掘りに:
   - [ルーティング](./routing.md) — ルートグループ、ミドルウェア、リソースルート。
   - [コントローラー](./controllers.md) — リクエスト処理、入力ヘルパー、バリデーション。
   - [データベース](./database.md) — Drizzle スキーマ、マイグレーション、QueryBuilder、リレーションシップ。
   - [フロントエンド](./frontend.md) — Inertia による React ページと SSR。
   - [テスト](./testing.md) — TestApp、fluent なアサーション、テストユーティリティ。
   - [スペックアンカード開発](./spec-anchored.md) — 生成図、アーキテクチャ上の意思決定、検証済みリンク、Docs Graph。

チュートリアルの前に軽くツアーをしたい方は、[ファーストステップ](./first-steps.md) をどうぞ。1 つのリクエストが各レイヤーをどう通るかを 10 分で辿れます。

CLI コマンドの一覧は [CLI リファレンス](./cli.md) を参照してください。見慣れない用語があれば [用語集](./glossary.md) で確認できます。

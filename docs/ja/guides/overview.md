# Guren を一目で

Bun で動く、Laravel のような書き心地のフルスタック TypeScript フレームワークです。

## まずはコードを見てください

ルート、コントローラー、型付きレスポンスが、これだけの行数で書けます。

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

React ページはコントローラーから型付きの props を直接受け取るので、API レイヤーを手で書く必要はありません。

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

**最初から Bun ネイティブ。** Guren は Bun ランタイム上で動き、HTTP レイヤーには Hono を使います。Node.js 向けの互換シムを挟まないので、Bun の速い起動、TypeScript のネイティブ実行、組み込みのテストランナーをそのまま活かせます。

**Laravel の開発体験を、TypeScript で。** Laravel を使ったことがあれば、リソースルーティング、`this.inertia()` を持つ `Controller` 基底クラス、`Model.where().orderBy().get()` といった書き方にはすぐ馴染めるはずです。Laravel を知らなくても、API は読めば何をするか分かるように作ってあります。

**エンドツーエンドの型安全。** Drizzle スキーマの型は、モデルからコントローラーを経て React ページの props まで引き継がれます。カラム名を変えると、データベースからブラウザまでの間で直すべき箇所を TypeScript がすべて教えてくれます。

**コードとつながり続けるプロジェクト知識。** Guren は、アーキテクチャ上の意思決定や生成したスペックを、対象のエンティティやコードパスに結び付けます。この結び付きは検証の対象になり、開発中はドキュメント全体を Docs Graph としてインタラクティブに眺められます。ワークフロー全体は [スペックアンカード開発](./spec-anchored.md) を参照してください。

**バッテリー同梱、ただし強制はしない。** 認証、バリデーション、キャッシュ、キュー、メール、イベント、ブロードキャスト、スケジューリングまで、必要になる機能はひと通り揃っています。各サブシステムは ServiceProvider で有効にする方式なので、読み込まれるのは実際に使うものだけです。

**設定より規約。** `bunx guren add auth` や `bunx guren add resource posts` を実行すると、機能一式が生成されます。ファイルをどこにどう置くかは CLI が決めるので、フォルダ構成を議論する時間を機能開発に回せます。

**グローバル状態ではなく registrar 方式のルーター。** 生成されるアプリはルートを登録する registrar を export し、それを `createApp({ routes })` に渡します。ルーティングはアプリケーションのインスタンスごとに閉じています。

Hono・Next.js・Laravel との踏み込んだ比較と、AI コーディングエージェント向けの設計思想については [Why Guren](./why-guren.md) を参照してください。

## はじめる

必要なコマンドは 4 つだけで、Docker もデータベースサーバーも要りません。新しく作ったアプリは最初から SQLite で動きます。

```bash
bunx create-guren-app my-app   # scaffold — accept the default prompts (SSR, SQLite)
cd my-app
bun install                    # usually a no-op: the scaffolder installs for you
bun run dev                    # start the dev server
```

`http://localhost:3333` を開けば、Guren アプリが動いています。

## さらに学ぶ

次の順番で進めるのがおすすめです。

1. **[クイックスタート](./getting-started.md)**: プロジェクトを雛形生成し、5 分程度で動かします。
2. **[Guren チュートリアル](../tutorials/00-overview.md)**: **初めての方に最もおすすめ。** 空のディレクトリから始めてデプロイまで、ブログを作りながら進める全 14 章のハンズオンです。各章では機能のひと区切りをコーディングエージェントに任せ、その結果をテストと `guren gate` で確かめます。最後まで進めると、主要な概念をひと通り押さえられるうえに、次の機能をエージェントに任せる手順も身につきます。
3. **トピック別ガイド**: 全体像を掴んだあと、機能ごとに詳しく読むためのガイドです。
   - [ルーティング](./routing.md): ルートグループ、ミドルウェア、リソースルート。
   - [コントローラー](./controllers.md): リクエスト処理、入力ヘルパー、バリデーション。
   - [データベース](./database.md): Drizzle スキーマ、マイグレーション、QueryBuilder、リレーションシップ。
   - [フロントエンド](./frontend.md): Inertia による React ページと SSR。
   - [テスト](./testing.md): TestApp、fluent なアサーション、テストユーティリティ。
   - [スペックアンカード開発](./spec-anchored.md): 生成図、アーキテクチャ上の意思決定、検証済みリンク、Docs Graph。

チュートリアルの前に全体を軽く見ておきたい場合は、[ファーストステップ](./first-steps.md) を読んでください。1 つのリクエストが各レイヤーをどう通っていくかを、10 分で追えます。

CLI コマンドの一覧は [CLI リファレンス](./cli.md) を参照してください。見慣れない用語があれば [用語集](./glossary.md) で確認できます。

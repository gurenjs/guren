# Guren を一目で

Laravel のような書き心地の、フルスタック TypeScript フレームワーク — Bun で動きます。

## まずはコードを見てください

ルート、コントローラー、型付きレスポンス — たった数行で：

```ts
// routes/web.ts
import TaskController from '@/app/Http/Controllers/TaskController'

Route.get('/tasks', [TaskController, 'index'])
Route.post('/tasks', [TaskController, 'store'])

Route.middleware('auth').group(() => {
  Route.get('/dashboard', [DashboardController, 'index'])
})
```

```ts
// app/Http/Controllers/TaskController.ts
import { Controller } from '@guren/server'
import { Task } from '@/app/Models/Task'

export default class TaskController extends Controller {
  async index() {
    const tasks = await Task.where('completed', false)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get()

    return this.inertia('Tasks/Index', { tasks })
  }

  async store() {
    const data = await this.only('title', 'description')
    const task = await Task.create(data)
    return this.redirect('/tasks')
  }
}
```

React ページにはコントローラーから型付き props がそのまま渡ります — API レイヤーの手書きは不要：

```tsx
// resources/js/pages/Tasks/Index.tsx
import type { ControllerInertiaProps } from '@guren/server'
import type TaskController from '@/app/Http/Controllers/TaskController'

type Props = ControllerInertiaProps<TaskController, 'index'>

export default function TasksIndex({ tasks }: Props) {
  return (
    <ul>
      {tasks.map((task) => (
        <li key={task.id}>{task.title}</li>
      ))}
    </ul>
  )
}
```

テストは英語を読むように書けます：

```ts
const app = await TestApp.create({ boot })

await app.get('/tasks').assertOk().assertJsonCount(3, 'tasks')
await app.post('/tasks', { title: 'Ship it' }).assertRedirect('/tasks')
await app.actingAs(user).get('/dashboard').assertOk()
```

## Guren の特徴

**Bun ネイティブ。** Guren は Bun ランタイム上で Hono を HTTP レイヤーとして動作します。Node.js の互換レイヤーはありません。Bun の高速起動、ネイティブ TypeScript 実行、組み込みテストランナーをそのまま活用できます。

**TypeScript で Laravel の開発体験。** Laravel を使ったことがあれば、パターンは一瞬で馴染みます：`Route.resource`、`Controller` と `this.inertia()`、`Model.where().orderBy().get()`。使ったことがなくても大丈夫です — API は「やりたいこと」がそのまま読めるように設計されています。

**エンドツーエンドの型安全。** Drizzle のスキーマ型が Model に流れ、Controller を通って、React ページの props まで到達します。カラム名を変えると TypeScript がデータベースからブラウザまで、更新が必要な箇所をすべてキャッチします。

**バッテリー同梱、でも強制しない。** 認証、バリデーション、キャッシュ、キュー、メール、イベント、ブロードキャスト、スケジューリング — 必要なときにすべて揃っています。各サブシステムは ServiceProvider によるオプトイン方式なので、使うものだけをロードします。

**設定より規約。** `bunx guren make:controller` でコントローラーを、`make:model` でモデルを、`make:route` でルートを生成。CLI が正しい場所に正しい構造でファイルを作るので、フォルダ構成の議論ではなく機能開発に時間を使えます。

## はじめよう

```bash
bunx create-guren-app my-app
cd my-app
bun install
bun run dev        # http://localhost:3333 にアクセス
```

## もっと学ぶ

Guren が初めての方は、この順番で進めてください：

1. **[はじめの一歩](./first-steps.md)** — 10分で動く機能を作ります。
2. **[環境構築](./getting-started.md)** — 環境設定とデータベースの準備。
3. **[ルーティングガイド](./routing.md)** — グループ、ミドルウェア、リソースルート。
4. **[コントローラーガイド](./controllers.md)** — リクエスト処理、入力ヘルパー、バリデーション。
5. **[データベースガイド](./database.md)** — Drizzle スキーマ、マイグレーション、QueryBuilder、リレーション。
6. **[フロントエンドガイド](./frontend.md)** — Inertia.js と React ページ、SSR。
7. **[テスティングガイド](./testing.md)** — TestApp、アサーション、テストユーティリティ。

CLI コマンドの詳細は [CLI リファレンス](./cli.md) を参照してください。用語がわからないときは [用語集](./glossary.md) をチェックしてください。

# コントローラガイド

コントローラは HTTP リクエストを受け取り、モデル経由でデータを取得し、Inertia や JSON でレスポンスを返します。すべてのコントローラは `app/Http/Controllers/` に置き、フレームワークの `Controller` を継承します。ここでは `routes/web.ts` に定義したルートとの連携も説明します。

## ルーティングの基本
`routes/web.ts` で Laravel 風の DSL を使ってルートを登録します。コントローラをインポートし、HTTP メソッドとパスに割り当てます。

```ts
// routes/web.ts
import PostsController from '@/app/Http/Controllers/PostsController'

Route.get('/', [PostsController, 'index'])
Route.get('/posts/:id', [PostsController, 'show'])
Route.post('/posts', [PostsController, 'store'])
```

- 各ルートはパスと `[ControllerClass, 'methodName']` タプルを受け取ります。
- `Route.group('/posts', () => { ... })` でプレフィックスやミドルウェアを共有できます。
- `src/main.ts` で `routes/web.ts` を 1 回インポートすると、副作用でルートが登録されます。

大規模になったら `routes/api.ts` など別ファイルを作り、`src/main.ts` から併せて読み込んで構いません。グループやミドルウェア、インラインハンドラの詳細は [Routing Guide](./routing.md) を参照してください。

## コントローラを作成する
CLI で雛形を生成できます:

```bash
bunx guren make:controller PostsController
```

生成物は `app/Http/Controllers/PostsController.ts` に最小のクラスを作ります。手動で作る場合も、`Controller` を継承したクラスをデフォルトエクスポートしてください。

```ts
// app/Http/Controllers/PostsController.ts
import { Controller } from '@guren/server'
import { Post } from '@/app/Models/Post'

export default class PostsController extends Controller {
  async index() {
    const posts = await Post.all()
    return this.inertia('posts/Index', { posts })
  }
}
```

## ルート登録
コントローラは `[Controller, 'method']` タプルで `routes/web.ts` に結びつけます。メソッドは非同期で構いません。

```ts
import PostsController from '@/app/Http/Controllers/PostsController'

Route.get('/posts', [PostsController, 'index'])
Route.post('/posts', [PostsController, 'store'])
```

## リクエストへのアクセス
- `this.ctx`: Hono のコンテキスト全体（ヘッダーやレスポンスヘルパーを含む）。
- `this.request`: 元の `Request` へのショートカット。
- `await this.request.json()` や `await this.request.formData()` でペイロードを読む。

## レスポンスを返す

| ヘルパー | 目的 |
|---------|------|
| `this.inertia(component, props, options?)` | `resources/js/pages/<component>.tsx` を使って Inertia ページを返します。`Promise<Response>` を返すため、アクションは `async` でそのまま `return` します。 |
| `this.json(data, init?)` | JSON を返却。 |
| `this.redirect(url, status?)` | 他の場所へリダイレクト（既定 302）。 |

カスタムヘッダーが必要なら `return this.ctx.newResponse(body, init)` で `Response` を直接生成できます。

## データの共有
コントローラはリクエストごとにインスタンス化されるため、インスタンスフィールドを設定して同一リクエスト内で使い回せます。全ページ共通のデータ（例: ユーザー情報）は Inertia の共有 props やミドルウェアで扱うのが適切です。

## Inertia 共有 Props
`setInertiaSharedProps()` を使うと、認証ユーザーなどの共通データを全 Inertia レスポンスに注入できます:

```ts
// config/inertia.ts
import { setInertiaSharedProps, AUTH_CONTEXT_KEY, type AuthContext } from '@guren/server'

setInertiaSharedProps(async (ctx) => {
  const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
  return { auth: { user: await auth?.user() } }
})
```

エクスポートされた `InertiaSharedProps` インターフェースを拡張すると、コントローラと React ページの両方で型付けされた props を利用できます:

```ts
// types/inertia.d.ts
import type { UserRecord } from '@/app/Models/User'

declare module '@guren/server' {
  interface InertiaSharedProps {
    auth: { user: UserRecord | null }
  }
}
```

コンポーネントの prop 型が欲しいときは `InferInertiaProps<ReturnType<Controller['action']>>` を使うと、アクションの props と共有 props を合わせた型になります。

## バリデーションのヒント
Guren は特定のバリデーションライブラリを強制しません。好みのもの（例: Zod）をコントローラ内で使ってください。

```ts
const data = await this.request.json()
const payload = PostPayload.parse(data)
await Post.create(payload)
```

失敗時はエラーを含めて `this.inertia()` を返すか、`this.json()` で適切なステータスコードを返してください。

## コントローラのテスト
- 単体テストでは、必要な依存を用意して `setContext(ctx)` を呼んだ上でメソッドを直接実行できます。
- E2E を書く場合は、起動中のアプリに `fetch` などでリクエストし、レスポンスを検証します。

ビジネスロジックをモデルやサービスに委譲すれば、コントローラは薄く保てます。アプリの調整役として扱いましょう。

## モデルヘルパー vs Drizzle RQB（併記例）

どちらのパターンもサポートしています。素早い CRUD にはモデルヘルパーを、JOIN・集計・ドライバー固有機能が必要なときは Drizzle のリレーショナルクエリビルダーを使います。

```ts
// Model-first: 簡潔で一貫性あり
import { Controller } from '@guren/server'
import { Post } from '@/app/Models/Post'

export default class PostsController extends Controller {
  async index() {
    const posts = await Post.orderBy(['publishedAt', 'desc'], { published: true })
    return this.inertia('posts/Index', { posts })
  }
}
```

```ts
// Drizzle RQB: より細かい制御、型安全は維持
import { Controller } from '@guren/server'
import { getDatabase } from '@/config/database'
import { posts, users } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'

export default class PostsController extends Controller {
  async index() {
    const db = await getDatabase()
    const postsWithAuthor = await db
      .select({
        id: posts.id,
        title: posts.title,
        author: users.name,
      })
      .from(posts)
      .leftJoin(users, eq(posts.authorId, users.id))
      .where(eq(posts.published, true))
      .orderBy(desc(posts.publishedAt))

    return this.inertia('posts/Index', { posts: postsWithAuthor })
  }
}
```

### SSR オプション

SSR バンドルが存在すれば、Guren は自動でサーバーレンダリングします。レスポンス単位で無効化/カスタマイズしたい場合は `ssr` オプションを渡します:

```ts
return this.inertia('posts/Index', props, {
  ssr: {
    enabled: false, // このレスポンスだけクライアントレンダリングにする
  },
})
```

より高度なケースでは `ssr.render` でカスタムレンダラーを渡し、`renderInertiaServer()` などのユーティリティに委譲できます。

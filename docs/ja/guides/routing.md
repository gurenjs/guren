# ルーティングガイド

Guren は Hono の HTTP サーバー上に Laravel 風のルーティング DSL を提供します。`routes/web.ts` をインポートすることで起動時にルートが登録され、パス・HTTP メソッド・コントローラーアクション・任意のミドルウェアを宣言的に定義できます。

## 基本の使い方
`routes/web.ts` を作成または編集し、`Route` ヘルパーと使用するコントローラーをインポートします。

```ts
import { Route } from '@guren/server'
import PostsController from '@/app/Http/Controllers/PostsController'

Route.get('/', [PostsController, 'index'])
Route.post('/posts', [PostsController, 'store'])
```

各ルートはパスと以下のいずれかを受け取ります。
- コントローラータプル `[ControllerClass, 'method']`
- インラインハンドラー `(ctx) => new Response('...')`

利用できるメソッドは `Route.get`、`Route.post`、`Route.put`、`Route.patch`、`Route.delete`、そして汎用の `Route.on(method, path, handler)` です。

## ルートグループ
`Route.group(prefix, callback)` を使って、共通のパスプレフィックスとミドルウェアを適用できます。

```ts
Route.group('/posts', () => {
  Route.get('/', [PostsController, 'index'])
  Route.get('/:id', [PostsController, 'show'])
})
```

グループはネスト可能です。プレフィックスは自動的にトリミングされるため、`/posts` + `/new` は `/posts/new` になります。

## ミドルウェア

### ルート単位のミドルウェア

ハンドラーの後にミドルウェアを追加するか、`.middleware()` メソッドでチェーンできます。

```ts
import { auth } from '@/app/Http/middleware/auth'

// インラインでミドルウェアを渡す
Route.post('/posts', [PostsController, 'store'], auth)

// 流暢なルート単位のミドルウェア
Route.get('/admin', [AdminController, 'index']).middleware('auth', 'admin')
```

### ミドルウェアエイリアス

ミドルウェア関数に短い名前を登録しておけば、ルート全体で文字列で参照できます。

```ts
import { Route, requireAuthenticated } from '@guren/server'
import { requireAdmin } from '@/app/Http/middleware/admin'

Route.aliasMiddleware('auth', requireAuthenticated())
Route.aliasMiddleware('admin', requireAdmin())
```

エイリアスを登録すれば、ミドルウェアが受け入れられる場所ならどこでも文字列名で使えます。

```ts
Route.get('/dashboard', [DashboardController, 'index']).middleware('auth')
Route.get('/admin', [AdminController, 'index']).middleware('auth', 'admin')
```

### ミドルウェアグループ

よく使うミドルウェアの組み合わせを一つの名前にまとめられます。

```ts
Route.groupMiddleware('web', ['session', 'csrf'])
Route.groupMiddleware('api', ['throttle:60'])
```

ミドルウェアグループをルートグループに適用します。

```ts
Route.middleware('web').group(() => {
  Route.get('/', [HomeController, 'index'])
  Route.get('/about', [PagesController, 'about'])
})

Route.middleware('auth').group(() => {
  Route.get('/dashboard', [DashboardController, 'index'])
  Route.get('/settings', [SettingsController, 'index'])
})
```

ミドルウェアグループと個別のエイリアスは自由に組み合わせられます。

```ts
Route.middleware('web', 'auth').group(() => {
  Route.get('/profile', [ProfileController, 'show'])
})
```

グローバル登録パターン、ビルトインヘルパー、セッションサポートの詳細は、専用の[ミドルウェアガイド](./middleware.md)をご覧ください。

## ルートパラメータ
動的パラメータは Hono の構文に従います。

```ts
Route.get('/posts/:id', [PostsController, 'show'])
```

コントローラー内では `this.ctx.req.param('id')` でパラメータを読み取ります。

オプショナルセグメントには Hono のパターンサポート（`Route.get('/posts/:id?', handler)`）を使い、ワイルドカードには `*`（例: `/:slug*`）を使います。

## ルートモデルバインディング

ルートモデルバインディングを使うと、ルートパラメータから Eloquent モデルのインスタンスを自動的に解決できます。パラメータ名とモデルクラスのバインディングを登録します。

```ts
import { Route } from '@guren/server'
import { Post } from '@/app/Models/Post'
import { User } from '@/app/Models/User'

Route.bind('post', Post)
Route.bind('user', User)
```

バインドされた名前と一致するパラメータを含むルートでは、Guren がプライマリキーで対応するモデルインスタンスを解決し、コントローラーに渡します。

```ts
// ルート定義
Route.get('/posts/:post', [PostsController, 'show'])
Route.get('/users/:user/posts/:post', [PostsController, 'showForUser'])

// コントローラーで解決済みのモデルインスタンスを受け取る
export default class PostsController extends Controller {
  async show() {
    // this.ctx.req.param('post') は解決済みの Post インスタンス
    const post = this.ctx.get('post') as PostRecord
    return this.inertia('posts/Show', { post })
  }
}
```

モデルが見つからない場合は、自動的に 404 レスポンスが返されます。

## ブートストラップ
`src/main.ts` でルートファイルをインポートし、アプリケーションの起動前にルートが登録されるようにします。

```ts
// src/main.ts
import '@/routes/web'

const app = new Application()
await app.boot()
await app.listen()
```

インポートは副作用のみです。`routes/web.ts` から明示的なエクスポートは必要ありません。

## カスタムハンドラー
インラインハンドラーを使えば、コントローラーなしで Hono の `Context` を直接扱えます。

```ts
Route.get('/health', (ctx) => ctx.json({ ok: true }))
```

ヘルスチェックや Webhook のような軽量エンドポイントに便利です。

## Tips
- `routes/web.ts` は HTTP 定義に集中させましょう。ビジネスロジックはコントローラーやサービスに移してください。
- 大規模なアプリでは、ルートを追加ファイル（例: `routes/admin.ts`）に分割し、`src/main.ts` からまとめてインポートします。
- 分かりやすいコントローラーメソッド名（`index`、`show`、`store`、`update`、`destroy`）を使うと、フレームワーク全体の規約と揃います。
- ミドルウェアエイリアスを活用すると、ルートファイルがすっきりし、あちこちでミドルウェア関数をインポートする必要がなくなります。
- ルートモデルバインディングはルートファイルの先頭で登録しておくと、以降のすべてのルートに適用されます。

ルーティング DSL を使えば、複雑な HTTP 構造を表現しながら、エントリーポイントをクリーンで宣言的に保てます。

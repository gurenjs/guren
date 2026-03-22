# ルーティングガイド

Guren は Hono の HTTP サーバー上に Laravel 風のルーティング DSL を提供します。推奨構成では `routes/web.ts` が registrar 関数を export し、アプリ起動時に app-local な `Router` へルートを登録します。

## 基本の使い方
`routes/web.ts` を作成または編集し、`Router` と使用するコントローラーをインポートします。

```ts
import { Router } from '@guren/core'
import PostsController from '@/app/Http/Controllers/PostsController'

export function registerWebRoutes(router: Router): void {
  router.get('/', [PostsController, 'index'])
  router.post('/posts', [PostsController, 'store'])
}
```

各ルートはパスと以下のいずれかを受け取ります。
- コントローラータプル `[ControllerClass, 'method']`
- インラインハンドラー `(ctx) => new Response('...')`

利用できるメソッドは `router.get`、`router.post`、`router.put`、`router.patch`、`router.delete`、そして汎用の `router.on(method, path, handler)` です。

## ルートグループ
`router.group(prefix, callback)` を使って、共通のパスプレフィックスとミドルウェアを適用できます。

```ts
router.group('/posts', (posts) => {
  posts.get('/', [PostsController, 'index'])
  posts.get('/:id', [PostsController, 'show'])
})
```

グループはネスト可能です。プレフィックスは自動的にトリミングされるため、`/posts` + `/new` は `/posts/new` になります。

## ミドルウェア

### ルート単位のミドルウェア

ハンドラーに `.middleware()` をチェーンして適用できます。

```ts
import { Router, requireAuthenticated } from '@guren/core'
import { requireAdmin } from '@/app/Http/middleware/admin'

export function registerWebRoutes(router: Router): void {
  router.aliasMiddleware('auth', requireAuthenticated())
  router.aliasMiddleware('admin', requireAdmin())

  router.get('/admin', [AdminController, 'index']).middleware('auth', 'admin')
}
```

### ミドルウェアエイリアス

ミドルウェア関数に短い名前を登録しておけば、ルート全体で文字列で参照できます。

```ts
import { Router, requireAuthenticated } from '@guren/core'
import { requireAdmin } from '@/app/Http/middleware/admin'

export function registerWebRoutes(router: Router): void {
  router.aliasMiddleware('auth', requireAuthenticated())
  router.aliasMiddleware('admin', requireAdmin())
}
```

エイリアスを登録すれば、ミドルウェアが受け入れられる場所ならどこでも文字列名で使えます。

```ts
router.get('/dashboard', [DashboardController, 'index']).middleware('auth')
router.get('/admin', [AdminController, 'index']).middleware('auth', 'admin')
```

### ミドルウェアグループ

よく使うミドルウェアの組み合わせを一つの名前にまとめられます。

```ts
router.groupMiddleware('web', ['session', 'csrf'])
router.groupMiddleware('api', ['throttle:60'])
```

ミドルウェアグループをルートグループに適用します。

```ts
router.middleware('web').group((web) => {
  web.get('/', [HomeController, 'index'])
  web.get('/about', [PagesController, 'about'])
})

router.middleware('auth').group((auth) => {
  auth.get('/dashboard', [DashboardController, 'index'])
  auth.get('/settings', [SettingsController, 'index'])
})
```

ミドルウェアグループと個別のエイリアスは自由に組み合わせられます。

```ts
router.middleware('web', 'auth').group((group) => {
  group.get('/profile', [ProfileController, 'show'])
})
```

グローバル登録パターン、ビルトインヘルパー、セッションサポートの詳細は、専用の[ミドルウェアガイド](./middleware.md)をご覧ください。

## ルートパラメータ
動的パラメータは Hono の構文に従います。

```ts
router.get('/posts/:id', [PostsController, 'show'])
```

コントローラー内では `this.validateParams()` か `this.ctx.req.param('id')` でパラメータを読み取ります。

オプショナルセグメントには Hono のパターンサポート（`router.get('/posts/:id?', handler)`）を使い、ワイルドカードには `*`（例: `/:slug*`）を使います。

## ルートモデルバインディング

毎回 `findOrFail()` を書きたくない場合は、ルートパラメータにモデルをバインドできます。

```ts
import { PostResource } from '@/app/Http/Resources/PostResource'
import { appPages } from '@/resources/js/pages/contracts'

router.bind('post', Post)
router.get('/posts/:post', [PostsController, 'show'])

async show() {
  const post = this.ctx.get('post') as PostRecord
  return this.inertia(appPages.posts.show, { post: new PostResource(post).toJSON() })
}
```

slug ベースの解決にしたい場合は、独自 resolver も渡せます。

```ts
router.bind('post', async (value) => Post.where('slug', value).firstOrFail())
```

## ブートストラップ
`src/app.ts` で registrar を `createApp()` に渡します。

```ts
// src/app.ts
import { createApp } from '@guren/core'
import registerWebRoutes from '@/routes/web'

const app = createApp({
  routes: registerWebRoutes,
})
```

## カスタムハンドラー
インラインハンドラーを使えば、コントローラーなしで Hono の `Context` を直接扱えます。

```ts
router.get('/health', (ctx) => ctx.json({ ok: true }))
```

ヘルスチェックや Webhook のような軽量エンドポイントに便利です。

## Tips
- `routes/web.ts` は HTTP 定義に集中させましょう。ビジネスロジックはコントローラーやサービスに移してください。
- 大規模なアプリでは、ルートを追加ファイル（例: `routes/admin.ts`）に分割し、`src/app.ts` で registrar を合成します。
- 分かりやすいコントローラーメソッド名（`index`、`show`、`store`、`update`、`destroy`）を使うと、フレームワーク全体の規約と揃います。
- ミドルウェアエイリアスを活用すると、ルートファイルがすっきりし、あちこちでミドルウェア関数をインポートする必要がなくなります。

ルーティング DSL を使えば、複雑な HTTP 構造を表現しながら、エントリーポイントをクリーンで宣言的に保てます。

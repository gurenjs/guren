# ルーティングガイド

ルートは、メソッドと URL の組み合わせを、それに応答するコード（コントローラーのアクションかインラインハンドラー）に結び付けます。アプリケーションはそれぞれ 1 つの `Router` を持ちます。ルートファイルは registrar（そのルーターを受け取ってルートを登録する関数）を export し、`src/app.ts` がその registrar を `createApp()` に渡します。

ルートには、バリデーションや codegen、エージェントツールが読むスキーマとメタデータ（コントラクト）も付けられます。書き方は[ルートコントラクト](./route-contracts.md)に、そこから生成する OpenAPI ドキュメントは [OpenAPI](./openapi.md) にまとめています。

## ルートの定義

生成したアプリの `routes/web.ts` は、registrar の `registerWebRoutes` をすでに export しています。ルートはその中に追加します。

```ts
// routes/web.ts
import { Router } from '@guren/core'
import PostsController from '@/app/Http/Controllers/PostsController'

export function registerWebRoutes(router: Router): void {
  // コントローラーのタプル（いちばんよく使う形）
  router.get('/posts', [PostsController, 'index'])
  router.post('/posts', [PostsController, 'store'])
  router.put('/posts/:id', [PostsController, 'update'])
  router.delete('/posts/:id', [PostsController, 'destroy'])

  // インラインハンドラー（ヘルスチェックや Webhook のような軽いエンドポイント向け）
  router.get('/health', (ctx) => ctx.json({ status: 'ok' }))
}
```

使えるメソッドは `router.get`、`router.post`、`router.put`、`router.patch`、`router.delete`、`router.query`（[QUERY メソッド](#query-メソッド)を参照）と、汎用の `router.on(method, path, handler)` です。

registrar は、`src/app.ts` で `createApp()` に渡します。雛形のファイルはほかにもオプションを渡していますが、ここで関係するのは `routes` だけです。

```ts
// src/app.ts
import { createApp } from '@guren/core'
import { registerWebRoutes } from '@/routes/web'

const app = createApp({
  routes: registerWebRoutes,
})

export default app
```

## ルートパラメータ

動的なセグメントは `:param` の形で書きます。

```ts
router.get('/posts/:id', [PostsController, 'show'])
router.get('/users/:userId/posts/:postId', [PostsController, 'showForUser'])
```

コントローラーでは次のように読み取ります。

```ts
const id = this.ctx.req.param('id')
const userId = this.ctx.req.param('userId')
```

パターンには Hono の構文が使えます。

| パターン | マッチするもの |
|----------|----------------|
| `/posts/:id?` | `/posts` と `/posts/42`（省略できるセグメント） |
| `/items/:id{[0-9]+}` | `/items/42`。`/items/abc` にはマッチしない（正規表現による制約） |
| `/files/:path{.+}` | `/files/a/b/c`（複数のセグメント） |

`/:slug*` は使わないでください。これは `slug*` という名前の 1 セグメントのパラメータとして登録され、Hono のワイルドカードにはならないので、`/files/x/y` には 404 を返します。

> [!NOTE]
> 大きなアプリでは、ルートを複数の registrar（`routes/api.ts`、`routes/admin.ts`）に分け、`src/app.ts` で組み合わせます。

## ルートグループ

共通のプレフィックスを持つルートをまとめると、同じパスを何度も書かずに済みます。

```ts
export function registerWebRoutes(router: Router): void {
  router.group('/posts', (posts) => {
    posts.get('/', [PostsController, 'index'])      // GET /posts
    posts.get('/:id', [PostsController, 'show'])    // GET /posts/:id
    posts.post('/', [PostsController, 'store'])     // POST /posts
  })
}
```

グループは入れ子にでき、プレフィックスは自動でつながります。

```ts
router.group('/admin', (admin) => {
  admin.group('/users', (users) => {
    users.get('/', [AdminUsersController, 'index']) // GET /admin/users
  })
})
```

## 名前付きルート

ルートに名前を付けておくと、パスを直接書く代わりに名前から URL を組み立てられます。

```ts
router.get('/posts/:id', [PostsController, 'show']).name('posts.show')

// あとで URL を組み立てる
const url = router.route('posts.show', { id: 42 })
// => '/posts/42'
```

パスを変えても、変更が必要なのはルートの定義だけです。たとえば `/posts` を `/articles` に変えても、名前で URL を組み立てているコードはそのまま動きます。

## ミドルウェア

ルートには `.middleware()` で、ルートのまとまりには `router.middleware().group()` でミドルウェアを付けます。`aliasMiddleware()` で登録した名前は、関数の代わりに使えます。グループ、実行順、組み込みのミドルウェアについては[ミドルウェアガイド](./middleware.md)を参照してください。

### ミドルウェアエイリアス

ミドルウェアの関数に短い名前を付けておくと、文字列で指定できます。

```ts
import { Router, requireAuthenticated } from '@guren/core'
import { requireAdmin } from '@/app/Http/middleware/admin'

export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated())
    .aliasMiddleware('admin', requireAdmin())

  router.get('/admin', [AdminController, 'index']).middleware('auth', 'admin')

  router.middleware('auth').group((auth) => {
    auth.get('/dashboard', [DashboardController, 'index'])
    auth.get('/settings', [SettingsController, 'index'])
  })
}
```

> [!IMPORTANT]
> `aliasMiddleware()` は、登録したエイリアス名を型に含んだ**新しい `Router` 型**を返します。戻り値を受け取らずに呼び出すと、登録した名前が型に反映されず、後に続く `.middleware('auth')` が型エラーになります。上の例のように、必ずチェーンして戻り値を受け取ってください。
>
> この型は関数をまたいでも引き継がれます。`Router<'auth' | 'guest'>` と型を付けた registrar には、その 2 つをエイリアス登録して戻り値を受け取った `router` を渡してください。元の `baseRouter` のままでは型が合いません。エントリの registrar だけは素の `Router` を受け取ります。この関数が自分でエイリアスを登録し、`createApp({ routes })` から渡される時点のルーターにはまだ何も登録されていないためです。

## ルートコントラクト

ルートを登録するメソッドの第 2 引数には、オプションのオブジェクトを渡せます。中には `params`、`query`、`body`、`output` の Zod スキーマと、`name`、`bind`、`agent` のメタデータを書きます。リクエストはアクションの前にこのスキーマで検証され、codegen や OpenAPI ドキュメント、エージェントツールにも同じ定義が使われます。

```ts
router.post('/posts', { body: CreatePostSchema, name: 'posts.store' }, [PostsController, 'store'])
```

各フィールドの意味は[ルートコントラクト](./route-contracts.md)で説明します。`bind` については、下の[ルートモデルバインディング](#ルートモデルバインディング)を参照してください。

## ルートモデルバインディング

モデルバインディングを使わないと、コントローラーのメソッドは毎回同じ処理から始まります。

```ts
// 使わない場合: どのメソッドでも手で検索する
async show() {
  const post = await Post.findOrFail(this.ctx.req.param('id'))
  return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
}
```

モデルバインディングを使うと、Guren がモデルを自動で取得します。ルートのオプションの `bind` でバインディングを宣言し（[ルートコントラクト](#ルートコントラクト)を参照）、コントローラーでは `this.model()` でレコードを受け取ります。

```ts
import { PostResource } from '@/app/Http/Resources/PostResource'
import { pages } from '@/.guren/pages.gen'

// routes/web.ts: :id は Post.findOrFail(id) で解決される
router.get('/posts/:id', { bind: { id: Post }, name: 'posts.show' }, [PostsController, 'show'])

async show() {
  const post = this.model(Post)  // PostRecord として型付け済み
  return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
}
```

レコードが見つからなければ、自動で 404 を返します。

### 主キー以外のカラムでバインドする

モデルクラスだけを渡すと、常に主キーで検索します。slug など別のユニークなカラムで探したいときは、`[Model, column]` のタプルを渡してください。ルーターが `Post.findOrFail(value, 'slug')` を呼び、`this.model(Post)` はそのレコードを返します。

```ts
router.get('/posts/:slug', { bind: { slug: [Post, 'slug'] }, name: 'posts.show' }, [PostsController, 'show'])

async show() {
  const post = this.model(Post)  // slug で解決済み
  // ...
}
```

カラム名はただの文字列として扱われます。綴りを間違えるとクエリ自体が失敗し、404 にはならないので、スキーマのカラム名と揃えてください。同じパラメータをルーター（後述）とルートの両方でバインドした場合は、ルート側の `bind` が優先され、検索は 1 回だけ行われます。

### ルーターレベルのバインディング

`router.bind(param, ...)` を使うと、そのルーターに登録したコントローラータプルのルートのうち、パスに同じ名前のパラメータを含むものすべてを一度にバインドできます。渡せるのは、`bind` オプションと同じモデルの形式（`Post` または `[Post, 'slug']`）と、独自の解決関数です。

```ts
router.bind('post', Post)                    // 主キーで検索
router.bind('post', [Post, 'slug'])          // slug で検索
router.bind('post', async (value) => Post.where('slug', value).firstOrFail())  // 独自の解決関数

router.get('/posts/:post', [PostsController, 'show'])
```

ルーターレベルのバインディングで解決した値は、コンテキストに続く**位置引数として**、パスパラメータの順に渡されます。モデルのバインディング（`Post` や `[Post, 'slug']`）なら `this.model(Post)` でも受け取れます。独自の resolver が返した値には引くためのモデルクラスがないので、位置引数でしか受け取れません。

```ts
import type { Context } from '@guren/core'

async show(_ctx: Context, post: PostRecord) {
  return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
}
```

> [!NOTE]
> バインドした値は Hono のコンテキストには格納されません。`this.ctx.get('post')` は `undefined` を返すので、`this.model(Post)` か位置引数を使ってください。また、バインディングはコントローラータプルのルートでしか解決されません。インラインハンドラーは Hono の `(ctx, next)` を受け取るので、レコードは自分で取得してください。

## リソースルート

`router.resource()` を使うと、1 行で RESTful なルート一式を登録できます。

```ts
router.resource('/posts', PostsController)
```

次のルートが登録されます。

| メソッド | パス | アクション | 名前 |
|--------|------|--------|------|
| GET | `/posts` | `index` | `posts.index` |
| GET | `/posts/create` | `create` | `posts.create` |
| POST | `/posts` | `store` | `posts.store` |
| GET | `/posts/:id` | `show` | `posts.show` |
| GET | `/posts/:id/edit` | `edit` | `posts.edit` |
| PUT | `/posts/:id` | `update` | `posts.update` |
| DELETE | `/posts/:id` | `destroy` | `posts.destroy` |

コントローラーにあるメソッドの分だけが登録されます。オプションで範囲を絞れます。

```ts
// API 専用。create と edit（HTML フォーム用）を外す
router.resource('/posts', PostsController, {
  only: ['index', 'show', 'store', 'update', 'destroy'],
})

// パラメータ名を変える
router.resource('/posts', PostsController, { param: 'post' })
```

## QUERY メソッド

`router.query()` は、HTTP の QUERY メソッド（[RFC 10008](https://www.rfc-editor.org/info/rfc10008/)）のルートを登録します。QUERY は GET と同じく安全（safe）で冪等なメソッドですが、POST のようにリクエストボディを持てます。URL に収まらない複雑な検索条件やフィルタ条件を受け取るエンドポイントに使ってください。

```ts
import { z } from 'zod'

router.query('/posts/search', {
  name: 'posts.search',
  body: z.object({ keywords: z.array(z.string()), limit: z.number().default(20) }),
}, [PostsController, 'search'])
```

使う前に、次の点を確認してください。

- **ハンドラーで状態を変更しないでください。** QUERY は安全なメソッドなので、Guren の CSRF 保護は QUERY を検査しません。ブラウザーは CORS のプリフライトなしに別のサイトから QUERY を送れないためですが、この前提はハンドラーが読み取り専用である間しか成り立ちません。それでも CSRF トークンを要求したい場合は、CSRF ミドルウェアの `methods` オプションに `'QUERY'` を追加してください。
- **呼び出しには `fetch` か、生成された API クライアント**（`client.request('posts.search', { body })`）を使います。HTML フォームや Inertia のフォームヘルパーは QUERY を送れません。
- **デプロイ先の経路を確認してください。** Guren の fetch ベースのアダプター（Bun、Cloudflare Workers / Vercel プラグイン）は QUERY をブロックしませんが、プラットフォームの入口が QUERY を受け付けるかどうかは別に確かめる必要があります。従来からあるメソッド以外を拒否するプロキシや CDN もあります。特に、Lambda プラグインのアセット配信でアプリの前段に置かれる CloudFront は、QUERY を転送しません。また、中間キャッシュで QUERY のレスポンスをキャッシュする仕組みも、まだ広くは実装されていません。
- **OpenAPI 3.1 では QUERY を表現できない**ので、`guren openapi:generate` は QUERY のルートを警告付きでスキップします。
- QUERY に対応していることをクライアントに知らせるには、リソースの GET ハンドラーなどで `Accept-Query` レスポンスヘッダーを自分で設定してください（例: `ctx.header('Accept-Query', 'application/json')`）。

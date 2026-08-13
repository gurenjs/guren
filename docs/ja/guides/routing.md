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

利用できるメソッドは `router.get`、`router.post`、`router.put`、`router.patch`、`router.delete`、`router.query`、そして汎用の `router.on(method, path, handler)` です。

### QUERY メソッド

`router.query()` は HTTP QUERY メソッド([RFC 10008](https://www.rfc-editor.org/info/rfc10008/))のルートを登録します。GET と同じく安全(safe)かつ冪等ですが、POST のようにリクエストボディを持てます。URL に収まらない複雑な検索・フィルタ条件を受け取るエンドポイントに使ってください。

```ts
import { z } from 'zod'

router.query('/posts/search', {
  name: 'posts.search',
  body: z.object({ keywords: z.array(z.string()), limit: z.number().default(20) }),
}, [PostsController, 'search'])
```

利用前に知っておくべきこと:

- **ハンドラーで状態を変更してはいけません。** QUERY は安全なメソッドであり、Guren の CSRF 保護はその前提で QUERY をスキップします(ブラウザは CORS プリフライトなしに QUERY を送信できないため、ハンドラーが読み取り専用である限り CSRF の心配はありません)。それでも CSRF トークンを要求したい場合は、CSRF ミドルウェアの `methods` オプションに `'QUERY'` を追加してください。
- **呼び出しは `fetch` か生成された API クライアント**(`client.request('posts.search', { body })`)で行います。HTML フォームや Inertia のフォームヘルパーは QUERY を送信できません。
- **デプロイ経路を確認してください。** Guren の fetch ベースのアダプター(Bun、Cloudflare Workers / Vercel プラグイン)は QUERY をブロックしませんが、プラットフォーム側の入口が QUERY を受け付けるかは確認が必要です。旧来のメソッドセット以外を拒否するプロキシや CDN があり、特に Lambda プラグインのアセット配信で前段に入る CloudFront は QUERY を転送しません。また、中間キャッシュによる QUERY レスポンスのキャッシュもまだ広くは実装されていません。
- **OpenAPI 3.1 は QUERY を表現できない**ため、`guren openapi:generate` は QUERY ルートを警告付きでスキップします。
- クライアントに対応を広告するには、リソースの GET ハンドラーなどで `Accept-Query` レスポンスヘッダーを自分で設定してください(例: `ctx.header('Accept-Query', 'application/json')`)。

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

export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated())
    .aliasMiddleware('admin', requireAdmin())

  router.get('/admin', [AdminController, 'index']).middleware('auth', 'admin')
}
```

### ミドルウェアエイリアス

ミドルウェア関数に短い名前を登録しておけば、ルート全体で文字列で参照できます。

```ts
import { Router, requireAuthenticated } from '@guren/core'
import { requireAdmin } from '@/app/Http/middleware/admin'

export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated())
    .aliasMiddleware('admin', requireAdmin())
}
```

> [!IMPORTANT]
> `aliasMiddleware()` は登録済みのエイリアス名を型に載せた**新しい `Router` 型**を返します。戻り値を受け取らずに呼び出すと登録名が型に伝わらず、後続の `.middleware('auth')` が型エラーになります。上記のように必ずチェーンして受け取ってください。

エイリアスを登録すれば、ミドルウェアが受け入れられる場所ならどこでも文字列名で使えます。

```ts
router.get('/dashboard', [DashboardController, 'index']).middleware('auth')
router.get('/admin', [AdminController, 'index']).middleware('auth', 'admin')
```

### ミドルウェアグループ

よく使うミドルウェアの組み合わせを一つの名前にまとめられます。グループのメンバーは、先にエイリアス登録済みの名前でなければなりません。

```ts
const router = new Router()
  .aliasMiddleware('auth', requireAuthenticated())
  .aliasMiddleware('admin', requireAdmin())
  .aliasMiddleware('session', createSessionMiddleware())
  .aliasMiddleware('csrf', createCsrfMiddleware())
  .aliasMiddleware('throttle', createRateLimitMiddleware({ limit: 60, windowMs: 60_000 }))
  .groupMiddleware('web', ['session', 'csrf'])
  .groupMiddleware('api', ['throttle'])
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
import { pages } from '@/.guren/pages.gen'

router.bind('post', Post)
router.get('/posts/:post', [PostsController, 'show'])

async show() {
  const post = this.ctx.get('post') as PostRecord
  return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
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

## ルートコントラクト

第 2 引数にオプションオブジェクトを渡すと、Zod スキーマとメタデータをルートに付与できます。フレームワークはこれらのスキーマをリクエストバリデーション、コード生成、OpenAPI ドキュメント生成に使用します。スキーマは zod 4 API(`import { z } from 'zod'`)で書いてください — zod v3 API で書かれたスキーマは構造読み取り系ツールが警告付きで拒否します([バリデーション](./validation.md) を参照)。

```ts
import { z } from 'zod'

const CreatePostSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
})

const PostIdParams = z.object({
  id: z.coerce.number().int().positive(),
})

router.post('/posts', {
  body: CreatePostSchema,
  name: 'posts.store',
}, [PostsController, 'store'])

router.get('/posts/:id', {
  params: PostIdParams,
  name: 'posts.show',
}, [PostsController, 'show'])
```

利用可能なコントラクトフィールド:

| フィールド | 用途 |
|-----------|------|
| `name` | URL 生成・コード生成用のルート名 |
| `params` | パスパラメータの Zod スキーマ |
| `query` | クエリパラメータの Zod スキーマ |
| `body` | リクエストボディの Zod スキーマ |
| `output` | レスポンスボディの Zod スキーマ |
| `resource` | Resource クラスによるレスポンスヒント — スキーマなしで API クライアントを型付け |
| `bind` | ルートモデルバインディングマップ |
| `middlewares` | ミドルウェアハンドラーの配列 |

> [!NOTE]
> 同じクエリキーが繰り返された場合、`query` スキーマには配列として渡されます（`?tag=a&tag=b` → `{ tag: ['a', 'b'] }`）。1 回だけ出現するキーは文字列のままです。詳細は[配列形式のクエリパラメータ](./validation.md#配列形式のクエリパラメータ)を参照してください。

### Resource レスポンスヒント

[API リソース](./api-resources.md)で応答するルートには、すでにレスポンス型があります。コード生成が Resource クラスから `.guren/data.gen.ts` に抽出する型です。そうしたルートに `output` スキーマを書くと、同じ形を Zod で二重定義することになり、2 つのコピーが乖離していきます。代わりに Resource そのものを宣言してください:

```ts
import { PostResource } from '@/app/Http/Resources/PostResource'

router.query('/posts/search', {
  name: 'posts.search',
  body: PostSearchSchema,
  resource: { data: [PostResource] },
}, [PostController, 'search'])
```

ヒントはコントローラーが組み立てる JSON をそのまま写します。単一リソースはクラスそのもの（`resource: PostResource`）、コレクションは要素 1 つの配列（`resource: [PostResource]`）、エンベロープはプレーンオブジェクトで表します。`{ data: [PostResource] }` は `this.json({ data: PostResource.collection(posts) })` に対応します。ネストは任意の深さで書けます。

`guren codegen` は各クラスを `app/Http/Resources` と突き合わせ、組み立てた形（この例では `{ data: Data.Post[] }`）で生成 API クライアントの `json()` を型付けします。`output` と違ってリクエスト時には何も実行されません。ヒントはあくまで宣言であり、見つからない Resource クラスを指した場合はコード生成が警告してレスポンスを型無しのままにする、という形でのみ検査されます。両方指定した場合は、実際に強制される側である `output` が優先されます。

### OpenAPI メタデータ

ルートコントラクトには軽量な OpenAPI アノテーションも指定できます。これらはルート定義に保存され、オプションの `@guren/openapi` プラグインで OpenAPI 3.1 ドキュメントを生成する際に使用されます。

```ts
router.post('/posts', {
  body: CreatePostSchema,
  output: PostResponseSchema,
  name: 'posts.store',
  summary: 'Create a post',
  description: 'Creates a new blog post.',
  tags: ['Posts'],
}, [PostsController, 'store'])

router.get('/posts/:id', {
  params: PostIdParams,
  name: 'posts.show',
  summary: 'Get a post',
  tags: ['Posts'],
  deprecated: false,
}, [PostsController, 'show'])
```

利用可能な OpenAPI フィールド:

| フィールド | 型 | 用途 |
|-----------|------|------|
| `summary` | `string` | ドキュメント UI に表示される短い説明 |
| `description` | `string` | エンドポイントの詳細な説明 |
| `tags` | `string[]` | ドキュメント UI でエンドポイントをグループ化 |
| `operationId` | `string` | 自動生成されるオペレーション ID を上書き |
| `deprecated` | `boolean` | エンドポイントを非推奨としてマーク |

スペックドキュメントの生成については CLI リファレンスの OpenAPI セクションを参照してください。

## OpenAPI ドキュメント生成

オプションの `@guren/openapi` パッケージをインストールして、ルート定義からスペックを生成します。

```bash
bun add @guren/openapi
bunx guren openapi:generate
```

ルートファイルを読み取り、ルートコントラクトから Zod スキーマと OpenAPI メタデータを抽出し、OpenAPI 3.1 JSON ドキュメントを `.guren/openapi.gen.json` に書き出します。

### CLI オプション

```bash
# タイトルとバージョンを指定
bunx guren openapi:generate --title "Blog API" --version "1.0.0"

# 出力パスを変更
bunx guren openapi:generate --out docs/openapi.json

# サーバー URL を含める
bunx guren openapi:generate --server "https://api.example.com"

# 既存ファイルを上書き
bunx guren openapi:generate --force
```

### ランタイムでのドキュメントマウント

OpenAPI スペックとインタラクティブなドキュメント UI をアプリケーションから直接配信することもできます。

```ts
import { createApp } from '@guren/core'
import { mountOpenApiDocs } from '@guren/openapi'

const app = createApp({ routes: registerWebRoutes })

mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
})
```

以下の 2 つのエンドポイントがマウントされます。

| パス | 説明 |
|-----|------|
| `/openapi.json` | 生成された OpenAPI 3.1 JSON ドキュメント |
| `/docs` | インタラクティブな API ドキュメント UI（Scalar） |

パスは `jsonPath` と `docsPath` オプションでカスタマイズできます。

```ts
mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
  jsonPath: '/api/openapi.json',
  docsPath: '/api/docs',
})
```

`Application` インスタンスにマウントする場合、ルート定義はルーターから自動的に読み取られます。素の Hono インスタンスの場合は `definitions` を明示的に渡してください。

`servers` オプションには配列だけでなく関数も渡せます。マウントされたドキュメントはリクエストごとに生成され、関数もそのたびに呼ばれるため、マウント時点ではまだ分からないアドレスを載せられます。たとえば `PORT=0` の場合、ポートは OS が割り当てるため `listen()` が返るまで確定せず、固定の配列ではドキュメントも、そこから生成したクライアントも、何も待ち受けていないアドレスを指したままになります。

```ts
mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
  servers: () => [app.address?.url ?? 'http://localhost:3000'],
})

await app.listen({ port: 0 })
```

`app.address` は `listen()` がこのアプリをバインドしたアドレスで、バインド前は `undefined` です。関数の中でこれを読むことで、エントリポイントを経由せずに済みます。アドレスを生み出したアプリへ、わざわざ外から渡し直す必要がありません。素の Hono インスタンスにマウントする場合は尋ねる先の `Application` がないため、そのアプリが知っている方法で関数の戻り値を組み立ててください。

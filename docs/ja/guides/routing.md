# ルーティングガイド

Guren には、Hono の HTTP サーバーの上で動く Laravel 風のルーティング DSL があります。推奨する構成では、`routes/web.ts` が registrar 関数を export し、アプリの起動時にそのアプリ専用の `Router` へルートを登録します。

## 基本の使い方
`routes/web.ts` を作成または編集し、`Router` と、使うコントローラーをインポートします。

```ts
import { Router } from '@guren/core'
import PostsController from '@/app/Http/Controllers/PostsController'

export function registerWebRoutes(router: Router): void {
  router.get('/', [PostsController, 'index'])
  router.post('/posts', [PostsController, 'store'])
}
```

各ルートには、パスと次のどちらかを渡します。
- コントローラーのタプル `[ControllerClass, 'method']`
- インラインハンドラー `(ctx) => new Response('...')`

使えるメソッドは `router.get`、`router.post`、`router.put`、`router.patch`、`router.delete`、`router.query` と、汎用の `router.on(method, path, handler)` です。

### QUERY メソッド

`router.query()` は、HTTP の QUERY メソッド（[RFC 10008](https://www.rfc-editor.org/info/rfc10008/)）のルートを登録します。QUERY は GET と同じく安全（safe）で冪等なメソッドですが、POST のようにリクエストボディを持てます。URL に収まらない複雑な検索条件やフィルタ条件を受け取るエンドポイントに使ってください。

```ts
import { z } from 'zod'

router.query('/posts/search', {
  name: 'posts.search',
  body: z.object({ keywords: z.array(z.string()), limit: z.number().default(20) }),
}, [PostsController, 'search'])
```

使う前に、次の点を確認してください。

- **ハンドラーで状態を変更しないでください。** QUERY は安全なメソッドなので、Guren の CSRF 保護はそれを前提に QUERY を検証の対象から外しています（ブラウザは CORS のプリフライトなしに QUERY を送れないので、ハンドラーが読み取り専用である限り CSRF の心配はありません）。それでも CSRF トークンを要求したい場合は、CSRF ミドルウェアの `methods` オプションに `'QUERY'` を追加してください。
- **呼び出しには `fetch` か、生成された API クライアント**（`client.request('posts.search', { body })`）を使います。HTML フォームや Inertia のフォームヘルパーは QUERY を送れません。
- **デプロイ先の経路を確認してください。** Guren の fetch ベースのアダプター（Bun、Cloudflare Workers / Vercel プラグイン）は QUERY をブロックしませんが、プラットフォームの入口が QUERY を受け付けるかどうかは別に確かめる必要があります。従来からあるメソッド以外を拒否するプロキシや CDN もあります。特に、Lambda プラグインのアセット配信でアプリの前段に置かれる CloudFront は、QUERY を転送しません。また、中間キャッシュで QUERY のレスポンスをキャッシュする仕組みも、まだ広くは実装されていません。
- **OpenAPI 3.1 では QUERY を表現できない**ので、`guren openapi:generate` は QUERY のルートを警告付きでスキップします。
- QUERY に対応していることをクライアントに知らせるには、リソースの GET ハンドラーなどで `Accept-Query` レスポンスヘッダーを自分で設定してください（例: `ctx.header('Accept-Query', 'application/json')`）。

## ルートグループ
`router.group(prefix, callback)` を使うと、複数のルートに共通のパスプレフィックスとミドルウェアを適用できます。

```ts
router.group('/posts', (posts) => {
  posts.get('/', [PostsController, 'index'])
  posts.get('/:id', [PostsController, 'show'])
})
```

グループは入れ子にできます。プレフィックスの前後の `/` は自動で整理されるので、`/posts` と `/new` を組み合わせると `/posts/new` になります。

## ミドルウェア

### ルート単位のミドルウェア

ルートに `.middleware()` をチェーンすると、そのルートにだけミドルウェアを適用できます。

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

ミドルウェア関数に短い名前を付けて登録しておくと、どのルートからも文字列で参照できます。

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
> `aliasMiddleware()` は、登録したエイリアス名を型に含んだ**新しい `Router` 型**を返します。戻り値を受け取らずに呼び出すと、登録した名前が型に反映されず、後に続く `.middleware('auth')` が型エラーになります。上の例のように、必ずチェーンして戻り値を受け取ってください。
>
> この型は関数をまたいでも引き継がれます。`Router<'auth' | 'guest'>` と型を付けた登録関数には、その 2 つをエイリアス登録して戻り値を受け取った `router` を渡してください。元の `baseRouter` のままでは型が合いません。エントリの登録関数だけは素の `Router` を受け取ります。エイリアスを登録するのはその関数自身で、`createApp({ routes })` が渡すルーターにはまだ何も登録されていないからです。

エイリアスを登録すると、ミドルウェアを指定できる場所ならどこでも、その名前を文字列で使えます。

```ts
router.get('/dashboard', [DashboardController, 'index']).middleware('auth')
router.get('/admin', [AdminController, 'index']).middleware('auth', 'admin')
```

### ミドルウェアグループ

よく使うミドルウェアの組み合わせは、1 つの名前にまとめられます。グループに入れるのは、先にエイリアスとして登録した名前だけです。

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

ミドルウェアグループは、ルートグループに適用します。

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

グローバルに登録する方法、組み込みのヘルパー、セッションの扱いについては、[ミドルウェアガイド](./middleware.md)を参照してください。

## ルートパラメータ
動的なパラメータは Hono の構文で書きます。

```ts
router.get('/posts/:id', [PostsController, 'show'])
```

コントローラー内では `this.validateParams()` か `this.ctx.req.param('id')` でパラメータを読み取ります。

省略可能なセグメント（`router.get('/posts/:id?', handler)`）や正規表現による制約（`router.get('/items/:id{[0-9]+}', handler)`）も、Hono のパターンとして使えます。複数のセグメントにまたがってマッチさせたいときは、`:path{.+}` のような制約付きのパラメータを使います。

`/:slug*` は Hono のワイルドカード構文ではないので注意してください。これは `slug*` という名前（アスタリスクを含む）の 1 セグメントのパラメータとして登録され、`/files/x/y` のような複数セグメントのパスには 404 を返します。値も `this.ctx.req.param('slug*')` のようにアスタリスク込みのキーで読むことになるので、使わないでください。

## ルートモデルバインディング

毎回 `findOrFail()` を書く代わりに、ルートパラメータにモデルをバインドできます。ルートの `bind` オプションでバインディングを宣言し、コントローラーでは `this.model()` でレコードを受け取ります。

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

カラム名はただの文字列として扱われます。綴りを間違えると、404 が返るのではなくクエリ自体が失敗するので、スキーマのカラム名と揃えてください。同じパラメータをルーター（後述）とルートの両方でバインドした場合は、ルート側の `bind` が優先され、検索は 1 回だけ行われます。

### ルーターレベルのバインディング

`router.bind(param, ...)` を使うと、そのルーターに登録したコントローラータプルのルートのうち、パスに同じ名前のパラメータを含むものすべてを一度にバインドできます。渡せるのは、`bind` オプションと同じモデルの形式（`Post` または `[Post, 'slug']`）と、独自の resolver 関数です。

```ts
router.bind('post', Post)                    // 主キーで検索
router.bind('post', [Post, 'slug'])          // slug で検索
router.bind('post', async (value) => Post.where('slug', value).firstOrFail())  // 独自 resolver

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
> バインドした値は Hono のコンテキストには格納されません。`this.ctx.get('post')` は `undefined` を返すので、`this.model(Post)` か位置引数を使ってください。また、バインディングが解決されるのはコントローラータプルのルートだけです。インラインハンドラーは Hono の `(ctx, next)` を受け取るので、レコードは自分で取得してください。

## ブートストラップ
registrar は、`src/app.ts` で `createApp()` に渡します。

```ts
// src/app.ts
import { createApp } from '@guren/core'
import registerWebRoutes from '@/routes/web'

const app = createApp({
  routes: registerWebRoutes,
})
```

## カスタムハンドラー
インラインハンドラーを使うと、コントローラーを作らずに Hono の `Context` を直接扱えます。

```ts
router.get('/health', (ctx) => ctx.json({ ok: true }))
```

ヘルスチェックや Webhook のような軽いエンドポイントに向いています。

## Tips
- `routes/web.ts` には HTTP の定義だけを書き、ビジネスロジックはコントローラーやサービスに移してください。
- 大きなアプリでは、ルートを別のファイル（例: `routes/admin.ts`）に分け、`src/app.ts` で registrar を組み合わせます。
- コントローラーのメソッドに `index`、`show`、`store`、`update`、`destroy` のような分かりやすい名前を付けると、フレームワーク全体の規約と揃います。
- ミドルウェアのエイリアスを使うとルートファイルがすっきりし、あちこちでミドルウェア関数をインポートせずに済みます。

ルーティング DSL を使うと、複雑な HTTP の構成も表現しながら、エントリーポイントを宣言的で見通しのよい形に保てます。

## ルートコントラクト

第 2 引数にオプションのオブジェクトを渡すと、ルートに Zod スキーマとメタデータを付けられます。フレームワークはこのスキーマを、リクエストのバリデーション、コード生成、OpenAPI ドキュメントの生成に使います。スキーマは zod 4 の API（`import { z } from 'zod'`）で書いてください。zod v3 の API で書いたスキーマは、構造を読み取るツールが警告を出して受け付けません（[バリデーション](./validation.md) を参照）。

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

使えるコントラクトのフィールドは次のとおりです。

| フィールド | 用途 |
|-----------|------|
| `name` | URL 生成・コード生成用のルート名 |
| `params` | パスパラメータの Zod スキーマ |
| `query` | クエリパラメータの Zod スキーマ |
| `body` | リクエストボディの Zod スキーマ |
| `output` | レスポンスボディの Zod スキーマ |
| `resource` | Resource クラスによるレスポンスのヒント（スキーマを書かずに API クライアントを型付けする） |
| `bind` | ルートモデルバインディングの対応表。`{ id: Post }`（主キー）または `{ slug: [Post, 'slug'] }`（別のカラム） |
| `middlewares` | ミドルウェアハンドラーの配列 |

> [!NOTE]
> 同じクエリキーが繰り返された場合、`query` スキーマには配列として渡されます（`?tag=a&tag=b` → `{ tag: ['a', 'b'] }`）。1 回しか出てこないキーは文字列のままです。詳しくは[配列形式のクエリパラメータ](./validation.md#配列形式のクエリパラメータ)を参照してください。

### 検証済み入力の読み取り

`params`、`query`、`body` のスキーマは、ハンドラーより先に検査されます。これはインラインハンドラーでもコントローラーのアクションでも同じです。どれかに違反したリクエストには 422 を返し、アクションは実行しません。Inertia のリクエストでは、エラーがフォームに flash され、キーは `validateBody()` と同じフィールドパスになります。

アクションでは、スキーマがパースした値を `this.validated()` で読みます。引数には、そのアクションのルート名を渡します。

```ts
import type { UserRecord } from '@/app/Models/User'

export default class PostsController extends Controller {
  async store() {
    const { body } = this.validated('posts.store')
    const user = await this.auth.userOrFail<UserRecord>()
    const post = await Post.create({ ...body, authorId: user.id })
    return this.redirect(`/posts/${post.id}`)
  }
}
```

値は coerce、デフォルト値、transform を適用した後の形で届くので、`z.coerce.number()` のパラメータは `number` になります。スキーマを宣言していないセグメントは `undefined` です。`guren codegen` を実行しておくと、ルート名がコンパイル時に検査され、戻り値もコントラクトから型付けされます。処理中のルートと違う名前を渡すと例外を投げます。PUT と PATCH のように 1 つのアクションを複数のルートに割り当てる場合は、`this.validated(['posts.update', 'posts.patch'])` のようにすべての名前を渡します。

コントラクトはアクションより先に実行されます。そのため、アクションの中で行う検査（`this.auth.userOrFail()` など）はボディが正しいときにしか実行されず、不正なボディには先に 422 が返ります。未認証のリクエストに 401 を先に返したい場合は、その検査をルートのミドルウェアに置いてください。`validateBody()`、`validateQuery()`、`validateParams()` もこれまでどおり使えます。コントラクトを宣言していないルートの検証には、これらを使います。

### Resource レスポンスヒント

[API リソース](./api-resources.md)で応答するルートには、すでにレスポンスの型があります。codegen が Resource クラスから `.guren/data.gen.ts` に抽出する型です。そのようなルートに `output` スキーマを書くと、同じ形を Zod でもう一度定義することになり、2 つの定義が少しずつ食い違っていきます。`output` を書く代わりに、Resource そのものを宣言してください。

```ts
import { PostResource } from '@/app/Http/Resources/PostResource'

router.query('/posts/search', {
  name: 'posts.search',
  body: PostSearchSchema,
  resource: { data: [PostResource] },
}, [PostController, 'search'])
```

ヒントは、コントローラーが組み立てる JSON と同じ形で書きます。単一のリソースはクラスそのもの（`resource: PostResource`）、コレクションは要素が 1 つの配列（`resource: [PostResource]`）、エンベロープはプレーンオブジェクトで表します。たとえば `{ data: [PostResource] }` は `this.json({ data: PostResource.collection(posts) })` に対応します。入れ子は何段でも書けます。

`guren codegen` は、各クラスをプロジェクトルートと各 `modules/<name>/` の `app/Http/Resources` から探し、組み立てた形（この例では `{ data: Data.Post[] }`）で、生成された API クライアントの `json()` を型付けします。`output` と違って、リクエスト時には何も実行されません。ヒントはあくまで宣言で、検査といえるのは codegen の時点だけです。見つからない Resource クラスを指定していると、codegen が警告を出し、レスポンスは型なしのままになります。両方を指定した場合は、実際に検査される `output` のほうが優先されます。

> [!NOTE]
> ヒントの末端は、すべて Resource クラスでなければなりません。Resource と通常の型付きオブジェクトが混ざったエンベロープ（たとえばページネーションのレスポンスにある `meta` と `links`）は、今のところ表現できません。そのようなルートには `output` スキーマを使ってください。

`guren openapi:generate` が読むのは `output` だけで、ヒントは OpenAPI に書き出せません。ヒントだけを宣言したルートは、生成したドキュメントにレスポンスのスキーマが入らず、コマンドもそのルートを挙げて警告を出します。OpenAPI のレスポンスが必要なルートには、`output` スキーマを指定してください。

### OpenAPI メタデータ

ルートコントラクトには、簡単な OpenAPI のアノテーションも指定できます。指定した内容はルート定義に保存され、オプションの `@guren/openapi` プラグインが OpenAPI 3.1 のドキュメントを生成するときに使われます。

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

使える OpenAPI のフィールドは次のとおりです。

| フィールド | 型 | 用途 |
|-----------|------|------|
| `summary` | `string` | ドキュメント UI に表示される短い説明 |
| `description` | `string` | エンドポイントの詳細な説明 |
| `tags` | `string[]` | ドキュメント UI でエンドポイントをグループ化 |
| `operationId` | `string` | 自動生成されるオペレーション ID を上書き |
| `deprecated` | `boolean` | エンドポイントを非推奨としてマーク |

スペックのドキュメントを生成する方法は、CLI リファレンスの OpenAPI の節を参照してください。

### エージェントツール

名前付きのルートに `agent` メタデータを宣言すると、そのルートが MCP ツールとして AI エージェントに公開されます。ツールの入力スキーマ、出力スキーマ、認可はすべて上のコントラクトから導出されるので、同じ内容を書き直す必要はありません。

```ts
// メソッドチェーン
router
  .post('/posts', { body: CreatePostSchema, output: PostResponseSchema }, [PostsController, 'store'])
  .name('posts.store')
  .agent({ description: 'Create a blog post as the authenticated user.' })

// ルートコントラクトのキーとして
router.post('/posts', {
  name: 'posts.store',
  body: CreatePostSchema,
  agent: { description: 'Create a blog post as the authenticated user.' },
}, [PostsController, 'store'])
```

`resource()` でも、アクションごとに同じメタデータを渡せます。**列挙しなかったアクションは公開されません**。

```ts
router.resource('/posts', PostsController, {
  agent: {
    index: { description: 'List posts.' },
    show: { description: 'Fetch one post by id.' },
  },
})
```

公開するかどうかはルートごとに選ぶオプトイン方式です。ツール名にはルート名がそのまま使われるので、`.name()` のないルートはツールにできません。ルートオプションの `agent` と `.agent()` のチェーンを両方書くと、登録時に例外を投げます。宣言は 1 か所だけにしてください。

エージェントから何が見えるかは、`bunx guren tool:list` で確認できます。メタデータの各フィールド、入出力の導出ルール、MCP エンドポイント、トークンのスコープ、監査ログについては、[エージェントインターフェースガイド](./agent-interface.md)を参照してください。

## OpenAPI ドキュメント生成

オプションの `@guren/openapi` パッケージをインストールすると、ルート定義からスペックを生成できます。

```bash
bun add @guren/openapi
bunx guren openapi:generate
```

このコマンドはルートファイルを読み取り、ルートコントラクトから Zod スキーマと OpenAPI メタデータを取り出して、OpenAPI 3.1 の JSON ドキュメントを `.guren/openapi.gen.json` に書き出します。

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

OpenAPI のスペックと、操作できるドキュメント UI を、アプリケーションから直接配信することもできます。

```ts
import { createApp } from '@guren/core'
import { mountOpenApiDocs } from '@guren/openapi'

const app = createApp({ routes: registerWebRoutes })

mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
})
```

次の 2 つのエンドポイントがマウントされます。

| パス | 説明 |
|-----|------|
| `/openapi.json` | 生成された OpenAPI 3.1 JSON ドキュメント |
| `/docs` | インタラクティブな API ドキュメント UI（Scalar） |

パスは `jsonPath` と `docsPath` オプションで変更できます。

```ts
mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
  jsonPath: '/api/openapi.json',
  docsPath: '/api/docs',
})
```

`Application` のインスタンスにマウントする場合、ルート定義はルーターから自動で読み取られます。素の Hono のインスタンスにマウントする場合は、`definitions` を明示的に渡してください。

`servers` オプションには、配列のほかに関数も渡せます。マウントしたドキュメントはリクエストのたびに生成され、関数もそのつど呼ばれるので、マウントした時点ではまだ分からないアドレスも載せられます。たとえば `PORT=0` の場合はポートを OS が割り当てるので、`listen()` が返るまでポート番号が決まりません。固定の配列を渡していると、ドキュメントも、そこから生成したクライアントも、何も待ち受けていないアドレスを指したままになってしまいます。

```ts
mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
  servers: () => [app.address?.url ?? 'http://localhost:3000'],
})

await app.listen({ port: 0 })
```

`app.address` は `listen()` がこのアプリをバインドしたアドレスで、バインドする前は `undefined` です。関数の中でこれを読めば、エントリポイントを経由する必要がなく、アドレスを決めたアプリ自身にそれを外から渡し直さずに済みます。素の Hono のインスタンスにマウントする場合は問い合わせる `Application` がないので、そのアプリがアドレスを知っている方法で、関数の戻り値を組み立ててください。

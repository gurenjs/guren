# ルーティングガイド

ルートは、メソッドと URL の組み合わせを、それに応答するコード（コントローラーのアクションかインラインハンドラー）に結び付けます。アプリケーションはそれぞれ 1 つの `Router` を持ちます。ルートファイルは registrar（そのルーターを受け取ってルートを登録する関数）を export し、`src/app.ts` がその registrar を `createApp()` に渡します。

ページの後半では、ルートコントラクト（ルートに付けるスキーマとメタデータ）を扱います。バリデーション、モデルバインディング、codegen、OpenAPI、エージェントツールは、どれもコントラクトをもとに動きます。

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
| `output` | レスポンスボディの Zod スキーマ。検証するのは 2xx の応答だけなので、エラーやリダイレクトはアプリが書いたまま返る |
| `resource` | Resource クラスによるレスポンスのヒント（スキーマを書かずに API クライアントを型付けする） |
| `bind` | ルートモデルバインディングの対応表。`{ id: Post }`（主キー）または `{ slug: [Post, 'slug'] }`（別のカラム） |
| `middlewares` | ミドルウェアハンドラーの配列 |

> [!NOTE]
> 同じクエリキーが繰り返された場合、`query` スキーマには配列として渡されます（`?tag=a&tag=b` → `{ tag: ['a', 'b'] }`）。1 回しか出てこないキーは文字列のままです。詳しくは[配列形式のクエリパラメータ](./validation.md#配列形式のクエリパラメータ)を参照してください。

### 検証済み入力の読み取り

`params`、`query`、`body` のスキーマは、インラインハンドラーでもコントローラーのアクションでも、ハンドラーより先に検査されます。どれかに違反したリクエストには 422 を返し、アクションは実行しません。Inertia のリクエストでは、エラーが次のリクエストまで保持されてフォームに戻り、キーは `validateBody()` と同じフィールドパスになります。

アクションでは、スキーマがパースした値を `this.validated()` で読みます。引数には、そのアクションのルート名を渡します。

```ts
import type { UserRecord } from '@/app/Models/User'

export default class PostsController extends Controller {
  async store() {
    const { body } = this.validated('posts.store')
    const user = await this.auth.userOrFail<UserRecord>()
    const post = await Post.create(body, { set: { authorId: user.id } })
    return this.redirect(`/posts/${post.id}`)
  }
}
```

- 値は型変換、デフォルト値、変換処理を適用した後の形で届くので、`z.coerce.number()` のパラメータは `number` になります。スキーマを宣言していないセグメントは `undefined` です。
- `guren codegen` でルートの型を生成しておくと、ルート名がコンパイル時に検査され、戻り値もコントラクトから型付けされます。処理中のルートと違う名前を渡すと、実行時に例外になります。
- PUT と PATCH のように 1 つのアクションを複数のルートに割り当てる場合は、`this.validated(['posts.update', 'posts.patch'])` のようにすべての名前を渡します。
- コントラクトはアクションより先に実行されるので、不正なボディには、アクションの中の検査（`this.auth.userOrFail()` など）より先に 422 が返ります。未認証のリクエストに 401 を先に返したい場合は、その検査をルートのミドルウェアに置いてください。

コントラクトを宣言していないルートは、これまでどおり `validateBody()`、`validateQuery()`、`validateParams()` で検証します（[バリデーション](./validation.md)を参照）。

### Resource レスポンスヒント

[API リソース](./api-resources.md)で応答するルートには、すでにレスポンスの型があります。codegen が Resource クラスから `.guren/data.gen.ts` に抽出する型です。そのようなルートに `output` スキーマを書くと、同じ形を Zod でもう一度定義することになり、2 つの定義が少しずつ食い違っていきます。`output` を書く代わりに、Resource そのものを宣言してください。

```ts
import { PostResource } from '@/app/Http/Resources/PostResource'

router.get('/api/posts', {
  name: 'posts.index',
  resource: { data: [PostResource] },
}, [PostsController, 'index'])
```

ヒントは、コントローラーが組み立てる JSON と同じ形で書きます。単一のリソースはクラスそのもの（`resource: PostResource`）、コレクションは要素が 1 つの配列（`resource: [PostResource]`）、エンベロープはプレーンオブジェクトで表します。たとえば `{ data: [PostResource] }` は `this.json({ data: PostResource.collection(posts) })` に対応します。入れ子は何段でも書けます。

`guren codegen` を実行すると、各クラスがプロジェクトルートと各 `modules/<name>/` の `app/Http/Resources` から探され、組み立てた形（この例では `{ data: Data.Post[] }`）で、生成された API クライアントの `json()` に型が付きます。

| | `output` スキーマ | `resource` ヒント |
|---|---|---|
| リクエスト時の検査 | あり（2xx の応答） | なし |
| API クライアントの型付け | あり | あり |
| OpenAPI ドキュメントへの出力 | あり | なし（`openapi:generate` が警告する） |
| 両方を指定したとき | 優先される | 無視される |

見つからない Resource クラスをヒントに書くと、codegen が警告を出し、レスポンスは型なしのままになります。

> [!NOTE]
> ヒントの末端は、すべて Resource クラスでなければなりません。Resource と通常の型付きオブジェクトが混ざったエンベロープ（たとえばページネーションのレスポンスにある `meta` と `links`）は、今のところ表現できません。そのようなルートには `output` スキーマを使ってください。

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

エージェントから何が見えるかは、`bunx guren tool:list` で確認できます。メタデータの各フィールド、入出力の導出ルール、MCP エンドポイントについては[エージェントインターフェースガイド](./agent-interface.md)を、トークンのスコープ、承認、監査ログについては[エージェントツールの権限と監査](./agent-tool-governance.md)を参照してください。

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

## OpenAPI ドキュメント生成

オプションの `@guren/openapi` パッケージをインストールすると、ルート定義からスペックを生成できます。

```bash
bun add @guren/openapi
bunx guren openapi:generate
```

このコマンドはルートファイルを読み取り、ルートコントラクトから Zod スキーマと OpenAPI メタデータを取り出して、OpenAPI 3.1 の JSON ドキュメントを `.guren/openapi.gen.json` に書き出します。

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

`app.address` は `listen()` がこのアプリをバインドしたアドレスで、バインドする前は `undefined` です。関数はリクエストのたびに呼ばれるので、`listen()` がアドレスを決めた後で読むことになります。素の Hono のインスタンスには問い合わせる `Application` がないので、そのアプリが知っている方法でアドレスを返してください。

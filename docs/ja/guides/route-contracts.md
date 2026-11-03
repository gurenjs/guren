# ルートコントラクト

ルートコントラクトは、ルートを登録するときに第 2 引数に渡すオプションのオブジェクトです。そこに書いたスキーマで、アクションの前にリクエストが検証されます。同じ定義から、ルートヘルパーと API クライアントの型、[OpenAPI ドキュメント](./openapi.md)、エージェントツールも作られます。パス、グループ、名前、ミドルウェア、モデルバインディングといったルートの登録そのものは、[ルーティング](./routing.md)で扱います。

## コントラクトの宣言

オプションのオブジェクトは、パスとハンドラーのあいだに置きます。スキーマは zod 4 の API（`import { z } from 'zod'`）で書いてください。zod v3 の API で書いたスキーマは、構造を読み取るツールが警告を出して受け付けません（[バリデーション](./validation.md) を参照）。

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
| `bind` | [ルートモデルバインディング](./routing.md#ルートモデルバインディング)の対応表。`{ id: Post }`（主キー）または `{ slug: [Post, 'slug'] }`（別のカラム） |
| `middlewares` | ミドルウェアハンドラーの配列 |

> [!NOTE]
> 同じクエリキーが繰り返された場合、`query` スキーマには配列として渡されます（`?tag=a&tag=b` → `{ tag: ['a', 'b'] }`）。1 回しか出てこないキーは文字列のままです。詳しくは[配列形式のクエリパラメータ](./validation.md#配列形式のクエリパラメータ)を参照してください。

## 検証済み入力の読み取り

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
- `.transform()` で終わるフィールドは `unknown` 型になります。関数が返す値の型を codegen が読めないためです。型を付けたいときは後ろにスキーマをつなぎます。`z.string().transform(Number).pipe(z.number())` なら `number` になります。
- `guren codegen` でルートの型を生成しておくと、ルート名がコンパイル時に検査され、戻り値もコントラクトから型付けされます。処理中のルートと違う名前を渡すと、実行時に例外になります。
- PUT と PATCH のように 1 つのアクションを複数のルートに割り当てる場合は、`this.validated(['posts.update', 'posts.patch'])` のようにすべての名前を渡します。
- コントラクトはアクションより先に実行されるので、不正なボディには、アクションの中の検査（`this.auth.userOrFail()` など）より先に 422 が返ります。未認証のリクエストに 401 を先に返したい場合は、その検査をルートのミドルウェアに置いてください。

コントラクトを宣言していないルートは、これまでどおり `validateBody()`、`validateQuery()`、`validateParams()` で検証します（[バリデーション](./validation.md)を参照）。

## Resource レスポンスヒント

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

## エージェントツール

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

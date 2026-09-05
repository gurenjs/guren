# エージェントインターフェース

AI エージェントは MCP を通じてアプリケーションを呼び出します。Guren では、エージェント向けにもう1つアプリケーションを書く必要はありません。エージェントツールは、**ルートがすでに持っているコントラクトから導出**されます。ルートの `params`・`query`・`body` スキーマがツールの入力スキーマになり、`output` スキーマがツールの出力スキーマになり、ミドルウェアチェーンが検査するポリシーがツールの認可になります。

ツールクラスを書く必要も、2つ目の JSON Schema を同期させ続ける必要もありません。形が1つしかないため、エンドポイントが検証しない形をツールが宣伝することは起こりえません。そしてツールが呼ばれると、その呼び出しは実際の HTTP リクエストとしてアプリケーションに再入します。検証もミドルウェアもポリシーも、いつもと同じ場所でちょうど1回だけ実行されます。

公開はルート単位のオプトインです。宣言しない限り、どのルートもツールにはなりません。

```ts
// routes/web.ts
import { Router, authorizeMiddleware } from '@guren/core'
import { PostController } from '@/app/Http/Controllers/PostController'
import { CreatePostSchema, PostListSchema, PostSchema } from '@/app/Http/Validators/PostValidator'

export function registerWebRoutes(router: Router): void {
  router
    .get('/posts', { output: PostListSchema }, [PostController, 'index'])
    .name('posts.index')
    .agent({ description: 'List published posts, newest first.' })

  router
    .post('/posts', { body: CreatePostSchema, output: PostSchema }, [PostController, 'store'])
    .name('posts.store')
    .middleware(authorizeMiddleware('create'))
    .agent({ description: 'Create a blog post as the authenticated user.' })
}
```

アプリケーション側の変更はこれだけです。以下は、そこから何が生まれたかを確認し、公開し、締めるための話です。

## エージェントから見えるものを確認する

```bash
bunx guren tool:list
```

```
Tool        | Method | Path   | MCP | WebMCP | Auth   | Annotations
-----------------------------------------------------------------------------
posts.index | GET    | /posts | yes | yes    | -      | read-only, idempotent
posts.store | POST   | /posts | yes | yes    | create | destructive

Total: 2 tools
```

`tool:inspect` は1つのツールの導出結果をすべて表示します。マージ済みの入力、出力スキーマ、認可の ability、アノテーション、そのツールに該当する警告です。

```bash
bunx guren tool:inspect posts.store
```

```
posts.store  POST /posts
Description:   Create a blog post as the authenticated user.
Exposure:      mcp=yes webMcp=yes
Annotations:   destructive
Authorization: create

Input
  title: string
  body: string

Output
{
  "type": "object",
  "properties": {
    "id": { "type": "number" },
    "title": { "type": "string" }
  },
  "required": ["id", "title"]
}
```

どちらのコマンドも、生成ファイルを読むのではなくルートグラフから直接導出します。そのため `.guren/agents.gen.ts` が存在しない場合や古い場合でも正しく答えます。`--json` を付けると導出結果そのものが出力されます。

`bunx guren codegen` は、ツールを1つ以上公開しているアプリに対して同じ導出結果を `.guren/agents.gen.ts` に書き出し、1つも公開していないアプリではそのファイルを削除します。[CLI: エージェントツールコマンド](./cli.md#エージェントツールコマンド)も参照してください。

## 自分でツールを呼ぶ

`tool:list` が表面を説明するのに対して、`tool:call` は実際に呼びます。MCP クライアントもトークンも、起動中のサーバーも必要ありません。

```bash
bunx guren tool:call posts.store --input '{"title":"Hello agents"}'
```

```
posts.store  POST /posts
Status:   201

Result
{
  "id": 1,
  "title": "Hello agents"
}
```

このコマンドはアプリケーションを起動し、MCP クライアントからの呼び出しとまったく同じ経路でディスパッチします: ツールは `deriveAgentTools` で解決され、HTTP リクエストはフレームワーク自身のディスパッチャが組み立て、レスポンスも同じ関数がマッピングします。その部分に CLI 専用の経路は存在しないので、解決されるツール、組み立てられるリクエスト、読み取る結果は、エージェントが受け取るものと同じです。

異なるのは呼び出し元が身元を示す方法です。MCP クライアントは bearer トークンを提示し、そのトークンはリクエスト組み立て前にスコープ検査を受け、cookie を持たないため CSRF 検証をスキップします。一方 `tool:call` は `--as` で認証し、ブラウザと同じ手順で CSRF トークンを取得します。したがって `tool:call` が成功したことは、そのツールが動くことを示しますが、特定のトークンがそこへ到達できるスコープを持つことは示しません: それを決めるのは `guren token:issue` です。

ツールの一覧は「起動済み」アプリのルートグラフから取ります。`--routes` フラグが無いのはそのためです: ルートファイルを差し替えても稼働中のアプリが提供するものは変わらず、名前は引けるのに到達できないツールが生まれるほうが害が大きいからです。カレントディレクトリ以外のアプリを指すときは `--app <dir>` を使います。

存在しない名前を渡すと、存在する名前を並べて答えます。呼び出しが失敗した場合はアプリケーション自身の失敗をそのまま報告し、終了コードは 0 以外になります。

```bash
bunx guren tool:call posts.store --input '{"title":"no"}' --json
```

```json
{
  "tool": "posts.store",
  "method": "POST",
  "path": "/posts",
  "status": 422,
  "isError": true,
  "content": "{\"errors\":{\"title\":\"Too small: expected string to have >=3 characters\"}}"
}
```

### `--as` は認証を迂回します

`--as user:42` はそのユーザーとして呼び出します。仕組みはプロセスに `GUREN_TESTING=1` を設定することで、アプリが実際の資格情報の代わりに注入されたユーザーを受け入れるようになります。`@guren/testing` と同じ仕組みです。このフラグを渡すたびにコマンドがその旨を警告します。

信頼境界は `bunx guren console` と同じで、実行できる人はすでにこのプロジェクトでコードを実行できる、という前提の開発用フラグです。共有環境や本番のデータベースに対しては絶対に実行しないでください。

### `--preflight` は呼び出しの予行演習です

```bash
bunx guren tool:call posts.store --input '{"title":"Rehearsal"}' --preflight
```

```
posts.store  POST /posts
Status:   200

Preflight  allowed (the handler did not run)
Validated: body
Unverified: authorization
```

リクエストはルートのミドルウェアを通り、ツールが公開しているコントラクトを検証したうえで、ハンドラーの手前で止まります。`unverified` は本当の呼び出しならまだ評価されるものを示します。アクションの内部で認可するルートは、この継ぎ目が構造上到達できないチェックだからです。

**予行演習はリクエスト全体のドライランではありません。** 継ぎ目は最後に置かれています。手前のゲートがすべて本物であることが verdict の価値そのものだからですが、同時にそれは、ルートのミドルウェアが実際に動いたということでもあります。クォータを加算する、レート制限の枠を消費する、セッションに触れる、外部を呼ぶ。そうしたミドルウェアの副作用は起きています。スキップされるのはハンドラーだけです。

MCP では、フラグではなく専用のツールから同じ継ぎ目に届きます([MCP 経由で呼び出しを予行演習する](#mcp-経由で呼び出しを予行演習する))。`outputSchema` を公開するツールはそれに適合する `structuredContent` で答えなければならず、verdict はどのルートの出力にも適合しないので、verdict には verdict 自身のツールが要ります。`tool:call` と `@guren/testing` はこの制約の下にないため、呼び出しそのものに対して verdict を求められます。

## ツールをテストする

`app.agent()` は、テスト対象アプリのツールを同じディスパッチ経路で呼びます。

```ts
import { TestApp } from '@guren/testing'

const app = await TestApp.create({ routes: registerWebRoutes })

const result = await app.agent().call('posts.store', { title: 'Hello' }, { as: user })
result.assertOk()

const post = result.assertStructured<{ id: number; title: string }>()
expect(post.title).toBe('Hello')
```

他の `TestApp` リクエストと同じく、呼び出しに直接アサーションをチェーンすることもできます。

```ts
await app.agent().call('posts.index').assertOk()
await app.agent().call('posts.store', { title: 'no' }).assertStatus(422)
await app.agent().call('secret.show').assertDenied()
```

| アサーション | 成功する条件 |
|-------------|-------------|
| `assertOk()` | 呼び出しがエラー結果として返らなかった(2xx/3xx のいずれか) |
| `assertStatus(code)` | ディスパッチがちょうどその HTTP ステータスに解決した |
| `assertDenied()` | アプリケーションが `401` または `403` を返した |
| `assertStructured<T>()` | ツールがオブジェクトの出力スキーマを公開し、それを返した。await した結果ではペイロードそのものを返します |

`await app.agent().tools()` は、`tool:list` と同じ導出でアプリが公開するツールを列挙します。

知っておくべき点が3つあります。

- **`{ as: user }` は `actingAs(user)` です。** `X-Testing-User` のエンベロープを使います。ここにトークンは存在しないので、`assertDenied()` は「アプリケーションが拒否した」という意味であり、認証か認可のどちらかです。bearer のスコープは MCP エンドポイント側の概念で、テストからは到達しません。
- **CSRF は意図して用意するか、意図して外してください。** ディスパッチされたツール呼び出しは cookie も bearer も持たないため、`auth` を付けて作ったアプリでは更新系の呼び出しがポリシーに届く前に `403` で拒否されます。これは `assertDenied()` からはポリシーによる拒否と区別できません。`(await app.withCsrf()).agent()` 経由で呼ぶか、CSRF を積まないアプリでテストしてください。
- **アプリがルートグラフを持っている必要があります。** `TestApp.create({ routes })` と `TestApp.fromApp(app)` は持っています。`TestApp.fromFetch()` と `TestApp.fromWorkers()` は素の fetch 関数を渡されるだけなので持っておらず、`agent()` は「ツールが0件」ではなくどのコンストラクタを使うべきかを伝えます。

`{ preflight: true }` もここで使え、同じ verdict を返します。

```ts
const result = await app.agent().call('posts.store', { title: 'x' }, { preflight: true })
result.assertOk()
expect(result.json<{ allowed: boolean }>().allowed).toBe(true)
```

## `.agent()` を宣言する

書き方は2通りあり、意味は同じです。ルートの他の記述と並べて読みやすいほうを選んでください。

```ts
// 登録したルートに対してチェーンする
router
  .post('/posts', { body: CreatePostSchema }, [PostController, 'store'])
  .name('posts.store')
  .agent({ description: 'Create a blog post as the authenticated user.' })

// ルートコントラクトのキーとして
router.post('/posts', {
  name: 'posts.store',
  body: CreatePostSchema,
  agent: { description: 'Create a blog post as the authenticated user.' },
}, [PostController, 'store'])
```

ルーターが登録時に強制するルールが2つあります。

- **オプションオブジェクトは第2引数、ハンドラーは最後の引数です。** `router.post(path, options, handler)` です。ルーターはオプションオブジェクトをキーの有無で判別し、そこには `agent` も含まれます。つまり `agent` だけを持つオブジェクトもハンドラーではなくオプションとして扱われます。
- **宣言は1回だけです。** ルートオプションの `agent` と `.agent()` チェーンを両方書くと例外になります。マージにしてしまうと、負けたほうの宣言が持っていたセキュリティ上重要なフィールド(`approval`・`redact`)が黙って落ちるためです。

**ツール名はルート名がそのまま使われます。** MCP のツール名文法(`^[A-Za-z0-9._-]{1,128}$`)はドットを許すため、`posts.store` に変換は不要です。`agent: { toolName: 'blog.createPost' }` で上書きできるのは綴りだけで、要件そのものは変わりません。ツール名はツールの識別子そのものなので、`.name()` のないルートはツールになれず、`guren check` は failure として報告します。

### リソースルート

`resource()` はアクションごとにメタデータを受け取ります。**列挙しなかったアクションは公開されません**。

```ts
router.resource('/posts', PostController, {
  agent: {
    index: { description: 'List posts.' },
    show: { description: 'Fetch one post by id.' },
    // create/store/edit/update/destroy はルートとしては登録されるが、
    // エージェントツールにはならない
  },
})
```

デフォルト拒否であることが要点です。すべてのエンドポイントを自動でツールに変換するのは既知のアンチパターンで、肥大したカタログを作り、それを読むエージェントの性能を落とします。エージェントが実際に必要とする少数のルートだけを公開してください。なお、その `resource()` 呼び出しが登録しなかったアクション(`only`・`except` で除外した、あるいはコントローラに存在しない)にメタデータを宣言すると例外になります。存在しえないツールへのメタデータは無視すべき記述ではなく、配線ミスだからです。

### メタデータのフィールド

| フィールド | 意味 |
|-------|---------|
| `description` | ツールが何をするか。未指定ならルートの OpenAPI `description`、次に `summary` が使われます。あなたのアプリを見たことのないエージェントに向けて書いてください。 |
| `toolName` | ツール名をルート名から上書きします。 |
| `expose` | `{ mcp?, webMcp? }` で、ツールが現れるプロトコル面を指定します。どちらも既定は true です。`expose: { mcp: false }` にすると MCP エンドポイントに載らなくなり、`expose: { webMcp: false }` にすると `@guren/plugin-webmcp`（実験的）が登録するブラウザ側の面に載らなくなります。 |
| `readOnlyHint` | ツールが何も変更しないという宣言です。[アノテーション](#アノテーション)を参照してください。 |
| `destructiveHint` | `false` は「追加のみで破壊しない」という強い主張です。 |
| `idempotentHint` | 同じ引数で繰り返し呼んでも追加の効果がないという宣言です。 |
| `approval` | `'required'` を付けると、呼び出しは実行されず、人間の承認を待つ申請になります。[承認が必要なツール](#承認が必要なツール)を参照してください。承認キューを設定していない場合、MCP エンドポイントは fail-closed で扱い、一覧にも出さず呼び出しも受け付けません。 |
| `redact` | 監査ログでマスクする引数のフィールド名です。[監査ログ](#監査ログ)を参照してください。 |

## 入力スキーマ

MCP はツールの入力が1つのオブジェクトであることを要求するため、ルートの `params`・`query`・`body` はこの順序で1つにマージされます。

```ts
router
  .get('/posts/:id/comments', {
    params: PostIdParamSchema,      // { id: number }
    query: CommentListQuerySchema,  // { page?: number, perPage?: number }
  }, [CommentController, 'index'])
  .name('posts.comments.index')
  .agent({ description: 'List the comments on one post.' })
```

```
Input
  id: number
  page?: number
  perPage?: number
```

押さえておきたい挙動は次のとおりです。

- **パスパラメータは常に必須です。** パスが宣言していて `params` スキーマが記述していないパラメータは、必須の文字列として補完されます。スキーマが記述しているパラメータも、スキーマの内容にかかわらず必須のままです。それがないと URL を組み立てられないためです(既知の制限: Hono のオプション修飾子 `/posts/:id?` も必須として提示されます。OpenAPI ドキュメントと同じ扱いです)。
- **オブジェクトでない body はネストします。** `body` が配列・プリミティブ・ユニオン・レコードの場合、フラットに展開されるのではなく `body` という1つのプロパティの下に入ります。ツールの入力はオブジェクトをルートに持つ必要があるためです。
- **キーの衝突はマージではなく報告されます。** 2つのソースが同じキーを宣言した場合、後のほう(params → path → query → body の順)が勝ち、導出は双方を名指しする警告を出します。この警告は `tool:list`、該当ツールの `tool:inspect`、そして MCP プラグインが起動したときのサーバーログに現れます。どちらか一方をリネームしてください。マージされたツール入力の名前空間は1つだけです。
- **提示される型はスキーマの入力側です。** `z.coerce`・`.default()`・`.transform()` は、エージェントが*書く*側の型として描画されます。コントローラが受け取る型ではありません。実際の検証は従来どおりアプリケーション境界で1回だけ行われます。

`body` スキーマのないボディ付きルートは、パスとクエリだけから入力を導出することになり、エージェントはペイロードを推測するしかなくなります。`guren check` はこれを warn します。

## 出力

優先順位は3段です。

| 優先度 | 供給元 | ツールが得るもの |
|---|---|---|
| 1 | ルートの `output` スキーマ | JSON Schema の `outputSchema` と、成功呼び出しごとの `structuredContent` |
| 2 | [`resource` ヒント](./routing.md#resource-レスポンスヒント) | スキーマはなし。`bunx guren codegen` が Resource から抽出した型テキストをツールの説明文に埋め込みます |
| 3 | どちらもなし | 出力の形は一切なし。`guren check` が warn します |

両方が宣言されている場合は `output` が勝ちます。ランタイムで検証される形は `output` スキーマだけであり、両方を持ち回ると1つのレスポンスに2つの記述が並び、両者を一致させ続けるものがなくなるためです。

`structuredContent` が提供されるのは、`outputSchema` が**オブジェクト**の場合だけです。MCP はそれ以外のルートを認めていません。`output` が配列やプリミティブのルートは structured なものを提示せず、結果はテキストとして返ります。

レスポンスがツール結果になるまでの対応は次のとおりです。

| レスポンス | 結果 |
|---|---|
| 2xx JSON | テキストとしてシリアライズされ、ツールがオブジェクトの出力スキーマを提示している場合は `structuredContent` も付きます |
| 2xx の Inertia ページ JSON | `page.props` に展開されます。出力スキーマを持たないツールに限られるため、提示した形と結果が食い違うことはありません |
| 204 / 3xx | ステータスと `Location` を示すテキスト1行。エラー扱いにはなりません |
| 4xx / 5xx | `isError: true` として例外ハンドラーの JSON ボディを載せます。422 の `{ message, errors }` はプロトコル障害ではなく、エージェントが読むべきアプリケーションの失敗です |
| JSON でないもの | 上限付きのテキスト |

この表を上書きするルールが1つあります。オブジェクトの出力スキーマを提示しているツールで、ルートがそれを満たせないもの(204、リダイレクト、JSON 配列、JSON でないボディ)を返した場合、成功結果ではなく不一致を名指しするエラー結果になります。ルートがすでに実行されたあとでクライアントに拒否されるより、その場で理由が分かるほうが有用だからです。

`this.inertia(...)` で応答するアクションは、ページがコンポーネントに渡した内容をそのまま返します。これは何も検査しない形であり、UI の変更で簡単に動きます。エージェント向けのルートでは `output` と `this.json(...)` を使ってください。Inertia のケースは `guren check` が warn します。

## アノテーション

MCP のアノテーションは、ツールをクライアントに説明するためのものです。Guren は3つすべてを明示的な値に解決するため、下流が既定値を再適用する必要はありません。

| アノテーション | 既定値 |
|---|---|
| `readOnlyHint` | GET と QUERY は true、それ以外は false |
| `destructiveHint` | `readOnlyHint` の逆。read-only でないものに対する MCP 仕様の既定値が `true` です |
| `idempotentHint` | GET・QUERY・PUT・DELETE は true |

**アノテーションはクライアント UX 向けのヒントであり、何も強制しません。** 強制するのはポリシー(ブラウザからの場合とまったく同じく、ディスパッチされたリクエストの内側で評価されます)と、トークンのスコープ(リクエストが組み立てられる前に評価されます)です。だからこそ、検査を*弱める*側の2つの主張はコントローラ本体と突き合わせて検査されます。

- `readOnlyHint: true` は認可ルールの適用を免除するものなので、read-only なツールのアクションがレコードを削除・更新・force-write していれば `guren check` が warn します。自分で書いたヒントだけでなく、GET・QUERY の既定値についても同じです。
- `destructiveHint: false` は「追加のみ」という主張なので、アクションが削除・更新・force-write していれば `guren audit` が warn します。

### 認証は認可ではありません

エージェントはブラウザセッションではなくトークンで呼び出します。`this.auth.userOrFail()` が証明するのは*誰が*呼んでいるかであり、その呼び出し元が*このアクションを*実行してよいかを決めるものではありません。認証だけで守られた read-only でないツールは、何かしらのトークンを持つあらゆる principal にそのアクション全体を渡すことになります。

そのため、read-only でないツールには次のいずれかが必要です。

```ts
// ルート側。こちらなら ability が導出可能になり、tool:list にも表示されます
router
  .delete('/posts/:id', { params: PostIdParamSchema }, [PostController, 'destroy'])
  .name('posts.destroy')
  .middleware(authorizeMiddleware('posts.destroy'))
  .agent({ description: 'Delete a post.' })
```

```ts
// またはアクションの中で
await this.authorize('delete', [Post, post])
```

`this.can(...)` では足りません。真偽値を返すだけで、何も強制しないためです。どちらもない read-only でないエージェントルートを、`guren check` は **failure** として報告します。

## ツールを公開する

ツールを配信するのは `@guren/plugin-mcp` です。エージェント向けの面を持たないアプリが MCP のトランスポートを抱え込まないよう、別パッケージになっています。

```bash
bunx guren plugin @guren/plugin-mcp
bun add @guren/plugin-mcp
```

```ts
// src/app.ts
import { createApp, EventServiceProvider, DatabaseApiTokenStore } from '@guren/core'
import { mcpPlugin } from '@guren/plugin-mcp'
import { apiTokens } from '@/db/schema'
import { registerWebRoutes } from '@/routes/web'

const app = createApp({
  routes: registerWebRoutes,
  providers: [EventServiceProvider, mcpPlugin()],
})

// 必須: エンドポイントはこのストアに対して bearer を検証します。
app.auth.useTokens(new DatabaseApiTokenStore(apiTokens))

export default app
```

エンドポイントは `/mcp` にマウントされ、ステートレスな streamable HTTP を話します。リクエストごとに MCP サーバーを1つ作るため、保持すべきセッションはありません。**bearer 認証は必須**なので、アプリは [API トークン](./api-tokens.md)ストアを設定する必要があります。

- bearer がない、または無効・期限切れ・失効している場合: MCP のフレーミングに入る前に `401` と `WWW-Authenticate: Bearer` を返します
- トークンストアがまったく設定されていない場合: `auth.useTokens(store)` を名指しする `500` を返します。設定ミスが、トークンを拒否したかのようにではなく設定ミスとして読めるようにするためです

このエンドポイントのために CSRF の例外を書く必要はありません。`Authorization: Bearer` を持ち、`Cookie` ヘッダーをまったく持たないリクエストは、フレームワーク全体で CSRF 検証をスキップします。守るべき ambient authority が存在しないためであり、ディスパッチャは構造上 cookie を持たない bearer リクエストを組み立てます。

### 設定

```ts
mcpPlugin({
  path: '/mcp',
  serverInfo: { name: 'blog', version: '1.0.0' },
  rateLimit: { max: 60, writeMax: 20, windowMs: 60_000 },
  updateLastUsed: true,
})
```

| オプション | 既定値 | 意味 |
|---|---|---|
| `path` | `'/mcp'` | エンドポイントのマウント先 |
| `serverInfo` | `{ name: 'guren-app', version: '1.0.0' }` | クライアントに提示するサーバー識別情報 |
| `rateLimit` | `{ max: 60, writeMax: 20, windowMs: 60_000 }` | トークンごとの予算。`false` で無効化 |
| `updateLastUsed` | `true` | bearer の検証時にトークンの `lastUsedAt` を更新するか |
| `approvals` | なし | 承認キュー。`{ store, notify, ttlMs? }` を渡します。[承認が必要なツール](#承認が必要なツール)を参照 |

レート制限のキーは IP ではなく**トークン ID** です。予算は資格情報に紐づきます。プロセスメモリ上で強制されるため、常駐サーバーが1台なら正確に効き、複数インスタンスやサーバーレスではインスタンスごとの制限になります。全体で1つの予算にするには、共有ストアとアプリ自身の[レート制限ミドルウェア](./rate-limiting.md)が必要です。

> エージェントルートにアプリ自身のレート制限ミドルウェアを置いても、この制限の代わりにはなりません。既定のキーはソケットのピアから作られますが、再入するリクエストはソケットを通っていないため、すべての MCP 呼び出し元がそのルートの共有バケットにまとまってしまいます。

### MCP 経由で呼び出しを予行演習する

エンドポイントは自前のツールを1つだけ追加します。`guren.preflight` です。ほかのツールへの呼び出しが許可されるかどうかを答え、その呼び出し自体は決して実行しません。

```json
{
  "name": "guren.preflight",
  "arguments": { "tool": "posts.store", "input": { "title": "Rehearsal" } }
}
```

```json
{
  "tool": "posts.store",
  "allowed": true,
  "status": 200,
  "validated": ["body"],
  "unverified": ["authorization"],
  "message": "Preflight only: the request passed this route's middleware and its body schema. …"
}
```

届く先は `--preflight` と同じ継ぎ目です。対象ツール自身のミドルウェアが動き、公開しているコントラクトが検証され、ハンドラーの手前でリクエストが止まります。アクション自体は実行されませんが、ミドルウェアは実際に動くので、その副作用は起きます。

拒否は error ではなく **success** の結果です。呼び出し元は「この呼び出しは許可されるか」を尋ねたのであり、「いいえ、理由はこれです」はその答えだからです。

```json
{
  "tool": "posts.store",
  "allowed": false,
  "status": 422,
  "message": "The given data was invalid.",
  "errors": { "title": ["Required"] }
}
```

`validated` と `unverified` は、リクエストが継ぎ目まで到達したときにだけ現れます。認証や認可のミドルウェアがそれより手前で拒否した場合、到達しなかったチェックについて語れることは何もないので、空配列ではなくフィールドごと省かれます。

覚えておきたい規則が4つあります。

- **ツールを確認するには、そのツールを呼ぶのと同じスコープが要ります。** そうでなければ、このツールは呼べないツールの認可面を探る手段になってしまいます。grant されていない名前は、直接呼んだときと同じく error の結果として拒否されます。
- **承認が必要なツールも確認できます。** そうしたツールは呼べず、一覧にも出ません。だからこそ「承認されれば通るのか」を尋ねる価値があり、予行演習は何も実行しません。
- **`guren.preflight` が一覧に出るのは、ツールを1つ以上 grant されたトークンに対してだけです。** 何も呼べないトークンには予行演習する対象がありません。
- **この名前は予約されています。** `.agent()` のツール名がこの名前を取るルートは `bunx guren check` で failure になり、エンドポイントもそのルートを公開しません。同じ名前のツールが2つあると、MCP クライアントはカタログ全体を拒否します。

予行演習は申請ではありません。承認が必要なツールを予行演習しても、申請は作られず、承認者にも通知されません。

## 承認が必要なツール

エージェントが求めたというだけで実行してはいけない操作があります。ルートに印を付けると、呼び出しは実行ではなく人間への申請になります。

```ts
router
  .delete('/posts/:id', { params: PostIdParamSchema }, [PostController, 'destroy'])
  .name('posts.destroy')
  .agent({ description: 'Delete a post.', approval: 'required' })
```

最初の呼び出しは拒否されます。何も実行されず、pending の申請が作られ、承認者に通知が飛び、エージェントには申請 ID が返ります。

```json
{
  "status": "pending",
  "requestId": "8f0c…",
  "tool": "posts.destroy",
  "requestedAt": "2026-09-01T12:00:00.000Z",
  "expiresAt": "2026-09-01T13:00:00.000Z",
  "executed": false,
  "pollWith": "guren.approval_status"
}
```

人間がその申請を承認したあと、エージェントが**同じ引数で同じ呼び出しを繰り返す**と、今度は1回だけ通ります。

### キューを設定する

既定のストアはありません。pending の申請をどこに置くかはアプリケーションの判断です。理由は監査シンクに既定値がないのと同じで、このエンドポイントは Workers や Lambda でも動きます。フレームワークが黙ってプロセスメモリにフォールバックすれば、次の isolate が知らない申請を承認済みとして扱ってしまいます。

```ts
import { AgentApprovalRequested } from '@guren/core'
import { mcpPlugin } from '@guren/plugin-mcp'

mcpPlugin({
  approvals: {
    store: new DrizzleApprovalStore(db),
    notify: (request) => notifications.sendToMany(admins, new AgentApprovalRequested(request)),
    ttlMs: 60 * 60 * 1000,
  },
})
```

`store` は `AgentApprovalStore` を実装します。

| メソッド | 役割 |
|---|---|
| `create(request)` | 新しい pending の申請を保存する |
| `find(id)` | この ID の申請、なければ `null` |
| `findMatch({ tool, fingerprint, principalKey })` | この呼び出しに一致する**未消費**の申請。状態は問わず、複数あれば最新のもの |
| `consume(id)` | 承認を消費し、*この*呼び出しが取れたかどうかを返す |

実装が守るべき保証が2つあります。

- **`consume` は compare-and-set にしてください。** `consumedAt` がまだ空のときだけ書き込み、埋まっていたら `false` を返します。同時に走った2つの呼び出しは同じ承認済みレコードを見つけるので、無条件に書き込む実装は両方に承認を渡してしまいます。
- **`findMatch` は期限も状態も絞り込みません。** 判定はフレームワーク側が行うので、ストアも判定すると規則の写しが2つになります。しかも壊れる向きが悪く、比較を1つ忘れれば先月の承認が今日の呼び出しを通してしまいます。

`notify` は申請を渡すだけで、誰に知らせるかはアプリケーションが決めます。フレームワークは承認者の一覧を見られないので、宛先を選びません。よくあるケース向けに `AgentApprovalRequested` を用意してあり、サブクラス化しても、まったく別のものを送ってもかまいません。申請は `notify` を呼ぶ**前**に保存され、呼び出しのあとで await もしません。メール経路が落ちていても失われるのは通知1通だけで、申請も呼び出しも失われません。失敗は申請 ID 付きでログに出ます。

申請を解決するのはアプリケーション側の仕事で、保存先もアプリケーションのものです。`status` を `'approved'` か `'rejected'` にし、`resolvedAt` と `resolvedBy` を書きます。フレームワークは `approve()` を提供しません。承認は、フレームワークからは見えない画面で人間が行う操作だからです。

### ゲートが強制する規則

- **承認は引数に紐づきます。** `posts.destroy {id: 5}` を承認しても `{id: 9}` は許可されません。キーの順序やネストの順序は一致判定を変えませんが、型は変えます。`{id: 5}` と `{id: '5'}` は別の呼び出しです。判定に使うのは**生の引数**を正規化した SHA-256 で、保存されるのはそのハッシュと redaction 済みの引数だけです。キューが秘密情報の第2の置き場所になることはありません。
- **承認は1回きりで、期限があります。** 1回通ったら次はまた新しい申請です。`expiresAt` を過ぎたレコードは何も許可しません。
- **承認は呼び出し元に紐づきます。** 引数が同じでも、別の principal の承認では通りません。
- **承認はディスパッチの前に消費されます。** そのあと呼び出しが失敗しても消費済みです。破壊的な操作が1つの承認で2回走るくらいなら、もう一度承認してもらうほうが安全だからです。
- **pending の呼び出しを繰り返しても申請は増えません。** 同じ申請 ID が返り、承認者への通知も2回目は飛びません。
- **却下された呼び出しは再申請されません。** 拒否には `"status": "rejected"` が入るので、エージェントはポーリングを続ける価値のある待ちと区別できます。レコードの期限が切れたあとは、改めて尋ねる新しい問いとして扱われます。

### `guren.approval_status`

キューを設定すると、エンドポイントは自前のツールをもう1つ追加します。拒否に入っていた `requestId` を渡してください。

```json
{ "name": "guren.approval_status", "arguments": { "requestId": "8f0c…" } }
```

```json
{
  "requestId": "8f0c…",
  "status": "approved",
  "tool": "posts.destroy",
  "requestedAt": "2026-09-01T12:00:00.000Z",
  "expiresAt": "2026-09-01T13:00:00.000Z",
  "resolvedAt": "2026-09-01T12:04:11.000Z",
  "resolvedBy": "ops@example.com",
  "executed": false
}
```

状態を読むだけでは何も実行されません。`"approved"` は「いまもう一度呼んでよい」という意味です。`guren.preflight` と同じくトークンの read 予算を消費するので、短い間隔でポーリングし続けると制限に掛かります。

読めるのは**自分が作った**申請の状態だけです。別の principal の ID は、存在しない ID とまったく同じ答えを返します。そうしなければ、このツールは同僚がどんな承認を待っているかを列挙する手段になってしまいます。呼び出し元に渡さない区別は監査ログのほうに残ります。状態の確認は `guren.approval_status` として記録される通常の invocation です。

`bunx guren check` は、`mcpPlugin({ … })` の呼び出しを読めて `approvals` が見つからないとき、`approval: 'required'` を宣言したルートを failure にします。キューがなければそのツールは守られているのではなく、呼べないだけだからです。

## トークンとスコープ

**既存の `['*']` トークンはエージェントツールを1つも grant しません。** ツールスコープとして読まれるのは `tool:` と `tools:` の ability だけで、それ以外の ability は、`ApiToken` の既定値である `['*']` を含めて何にもマッチしません。これは意図的な設計です。アプリが最初の `.agent()` ルートを宣言した瞬間に、エージェントツールが存在する前に発行された全トークンへエージェント面全体が渡ってしまう、という事故を防ぐためです。エージェント面へのアクセスは明示的に grant されるか、まったく grant されないかのどちらかです。

スコープの形は4つだけです。

| スコープ | grant する範囲 |
|---|---|
| `tool:posts.store` | そのツール1つだけ |
| `tools:read` | 解決後の `readOnlyHint` が true のツールすべて |
| `tools:posts.*` | `posts.…` という名前のツールすべて(ドットも一致条件なので、`posts` 自身は含まれません) |
| `tools:*` | すべてのツール |

スコープは加算的で、拒否の形はありません。トークンのスコープに含まれないツールは、単に拒否されるだけでなく **`tools/list` に現れません**。grant されていないカタログが、read-only なエージェントに書き込み面の地図を渡してしまわないようにするためです。

### トークンを発行する

```bash
bunx guren token:issue --name blog-reader --user 42 --tools 'tools:read' --expires 30d
```

```
✔ Issued token "blog-reader" for user 42.

Token (shown once — it is stored hashed and cannot be recovered)
  1|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Expires  2026-09-29T09:00:00.000Z
Abilities  tools:read
Granted tools
  read: posts.index, posts.show
  write: (none)
```

書き込みも行うエージェントには、このトークンのスコープを広げるのではなく、別のトークンを発行します。

```bash
bunx guren token:issue --name blog-writer --user 42 --tools 'posts.store' --expires 30d
```

`--tools` は短縮形も受け付けます。名前だけなら `tool:<name>`、`posts.*` は `tools:posts.*`、`read` は `tools:read`、`*` は `tools:*` になります。

| オプション | 意味 |
|---|---|
| `--name` | 必須。誰かが失効させるときにこのトークンを識別する名前です。 |
| `--user` | 必須。トークンが認証する対象のユーザー ID です。 |
| `--tools` | 必須。カンマ区切りのスコープです。 |
| `--read-only` | grant を read-only なツールに限定します。 |
| `--expires` | `30d`・`12h`・`45m`。省略すると期限なしのトークンになります。 |
| `--allow-unmatched` | 現在どのツールにもマッチしないスコープを受け入れます。 |
| `--yes` | `tools:*` を受け入れるために必須です。 |
| `--json` | 発行したトークンを JSON で出力します。警告も含まれます。 |

このコマンドは warn より refuse を選びます。資格情報を扱うコマンドラインのタイプミスは、まだ画面を見ている間に直すのが一番安いからです。

- **現在どのツールにもマッチしないスコープは拒否されます。** タイプミスであるか、*latent grant* であるかのどちらかです。latent grant とは、マッチするツールが追加された瞬間に、誰の同意もなく有効になる保存済みパターンのことです。`--allow-unmatched` で上書きでき、そのときはまさにその点を warn します。
- **`tools:*` には `--yes` が必要です。** アプリが今公開しているツールと、これから増えるツールのすべてを grant します。破壊的なものも含めてです。
- **`--read-only` は具体的なエントリを保存します。** grant は発行時に展開され、パターンではなく `tool:<name>` エントリとして書き込まれます。この文法には「`posts.*` の read-only な部分集合」という形が存在しないためです。これは fail-closed です。あとから `posts.` ファミリーに書き込み系ツールが追加されても、保存済みエントリのどれにも加わりません。また `--read-only` のもとでは、マッチしないスコープは `--allow-unmatched` を付けても拒否されます。あとから何かを grant することも決してできないためです。

発行時の警告は2つあり、どちらも拒否ではありません。

- 期限なしのトークンは、誰かが手で失効させるまで有効なままです
- 読み取り系と書き込み系のツールを**両方**含むトークンは、既知のインジェクション事例が取った形そのものです。攻撃者の影響下にあるコンテンツを読み、かつ書き戻せるエージェントは、そのコンテンツに誘導されうるからです。可能なら2つのトークンに分けてください

## 監査ログ

すべての呼び出しと、すべての拒否がフレームワークのイベントとして発行されます。イベントをすでに転送している先へ、そのまま転送できます。

| イベント | 発生タイミング | 保持する情報 |
|---|---|---|
| `AgentToolInvoked` | 呼び出しがアプリケーションに到達した | `principal`・`tool`・`arguments`・`status`・`durationMs`・`surface` |
| `AgentToolDenied` | HTTP が発生する前にアダプタが拒否した | `principal`・`tool`・`arguments`・`reason`・`surface` |

`reason` は `'auth'`・`'scope'`・`'approval'`・`'rate-limit'` のいずれかで、これはリクエストに先立つ検査そのものです。**ポリシーによる拒否はここに含まれません。** ポリシーはディスパッチされたリクエストの内側で評価されるため、ステータス `403` の `AgentToolInvoked` として届きます。拒否はステータスも所要時間も持ちません。何も実行されていないからです。

`guren.preflight` の呼び出しも、ほかの呼び出しと同じく `tool: 'guren.preflight'` として記録されます。エージェントが「自分に何が許されているか」を探ったことは、監査ログがまさに残したい情報です。確認された側のツールには記録が残りません。何も呼び出されていないからです。拒否も同じで、`guren.preflight` の `AgentToolDenied` になります。確認された側のツール名で記録すると、予行演習の拒否と、書き込みツールへの本当の呼び出しの拒否が区別できなくなるためです。どのツールが探られたかは記録の引数(`tool`)に残ります。

```ts
// app/Providers/EventServiceProvider.ts など、リスナーを登録している場所
import { AgentToolInvoked, AgentToolDenied, createFacades } from '@guren/core'

const { Events, Log } = createFacades(app.container)

Events.on(AgentToolInvoked, (event) => {
  Log.info('agent tool invoked', {
    tool: event.tool,
    principal: event.principal?.id,
    status: event.status,
    durationMs: event.durationMs,
    arguments: event.arguments,
  })
})

Events.on(AgentToolDenied, (event) => {
  Log.warn('agent tool denied', { tool: event.tool, reason: event.reason })
})
```

これらが動くにはイベントマネージャがバインドされている必要があります。`mcpPlugin()` と並べて `EventServiceProvider`(またはアプリ自身のイベントプロバイダ)を登録してください。ないままだとプラグインは起動時に警告を出し、イベントを1つも発行しません。

### 監査ログを書き出す

イベントは、記録する仕組みがあるかどうかに関わらず発行されます。記録を残すには、プラグインにシンクを設定します。

```ts
import { mcpPlugin } from '@guren/plugin-mcp'

createApp({
  providers: [
    EventServiceProvider,
    mcpPlugin({
      audit: { file: 'storage/logs/agent-audit.log', days: 30 },
    }),
  ],
})
```

1 行につき 1 件の JSON レコードを、指定したパスの隣にある `agent-audit-YYYY-MM-DD.log` へ日次でローテーションしながら追記します。`days` より古いファイルはローテーション時に削除されます(既定は 14 日)。`file` はファイルシステムがそのまま解決するため、絶対パスか、プロセスのカレントディレクトリからの相対パスを指定してください。アプリケーションルートからの解決は行いません。

ファイル以外へ書き出すときは、関数を渡します。

```ts
mcpPlugin({
  audit: {
    sink: async (record) => {
      await auditStream.write(record)
    },
  },
})
```

シンクが例外を投げた場合は警告が出ますが、記録対象だったツール呼び出し自体は失敗しません。

シンクを設定すると `bunx guren tool:call` も記録の対象になります。このコマンドはアプリケーションを起動するので、アプリが設定した監査ログをそのまま見つけて書き込みます。1 回の呼び出しにつき 1 件、`surface: 'cli'` として、引数は同じ `.agent({ redact })` のリストでマスクされ、MCP の記録と同じファイルに並びます。2 つ目のファイルはできません。これは実用上も重要です。ターミナルからの呼び出しは `--as` が指定したユーザーとして実行され、検証される資格情報は 1 つもありません。監査ログが本来残したいのは、まさにこの種の書き込みです。

`bunx guren tool:call --preflight` は、MCP 経由の予行演習とまったく同じく `guren.preflight` として記録され、確認された側のツール名は引数に残ります。ハンドラーは実行されていないので、そのツール名で記録してしまうと、完了した呼び出しと見分けがつかなくなるためです。アプリケーションの `@guren/core` が preflight のシームより古い場合は呼び出しが実際に実行されます。コマンドはその旨を警告し、記録には実際に実行されたツールの名前が残ります。

`tool:call` が記録するのは invocation だけで、denial は記録しません。4 つの denial の理由は、いずれもアダプターがリクエストを組み立てる前に行うチェックを指しますが、このコマンドはそのどれも行いません。トークンを持たず、アプリへ直接ディスパッチするためです。アプリケーションが返した 401 や 403 はレスポンスなので、ほかの surface と同じく、そのステータスを持つ invocation として記録されます。principal は `--as` が指定したユーザー、指定がなければ `null` です。`abilities` は含めません。abilities はトークンのものであり、ここにはトークンが存在しないからです。

シンクを設定していないアプリケーションでは、ここでも何も記録されません。呼び出し自体はこれまでどおり実行され、結果も表示されます。

**シンクが任意設定なのは意図的です。** このエンドポイントは、書き込み可能なファイルシステムを持たない Workers や、ファイルシステムが揮発する Lambda でも動きます。フレームワークが勝手に追記を始めると、設定は同じに見えるのにデプロイ先ごとに記録が静かに欠落する監査ログができあがります。監査ログは完全かどうかが分かって初めて価値があるので、Guren は書き出し先を明示させます。

### 監査ログを読む

```bash
# 直近 50 件
bunx guren tool:log

# 追従表示。日付が変わってファイルが切り替わっても追い続けます
bunx guren tool:log --tail

# 拒否だけ、特定のツールだけ、直近 2 時間だけ
bunx guren tool:log --denied
bunx guren tool:log --tool posts.store --since 2h -n 200

# 1 行 1 レコードの生データ。パイプ処理向け
bunx guren tool:log --json | jq 'select(.status >= 400)'
```

| オプション | 意味 |
|---|---|
| `--file <path>` | 監査ログのベースパス(既定は `storage/logs/agent-audit.log`) |
| `--tail`・`-f` | レコードの到着に追従する |
| `--tool <name>` | 指定したツールのみ |
| `--surface <s>` | `mcp`・`dev-mcp`・`cli`・`webmcp`・`durable` のいずれかのみ |
| `--denied` | 拒否のみ |
| `--since <duration>` | `30m`・`2h`・`7d` などより新しいレコードのみ |
| `-n <count>` | 表示件数(既定は 50) |
| `--app <dir>` | ベースパスの解決に使うアプリケーションルート |
| `--json` | 1 行 1 レコードの生データ |

`tool:log` はアプリケーションを起動しません。記録対象のアプリが起動しなくなっていても監査ログは読めるべきだからです。ローテーションされたファイル群を新しいものから順に読むので、日付をまたぐ `-n` も正しく機能します。また `-n` はフィルタの適用後に効きます。`--denied -n 50` は「直近 50 件のうちの拒否」ではなく「直近 50 件の拒否」です。

監査ログが 1 件も見つからないときは、空のリストではなく、追加すべき設定行を表示します。ここで空のリストを出すと「エージェントは何も触っていない」と読めてしまいますが、シンクが未設定なだけの場合にそれはまったく逆の結論です。

### redaction

`event.arguments` は、イベントが構築される前にマスクされます。2つのソースの和集合です。1つはすべてのアプリが何もせずに得られる機微なキー断片の組み込みリスト(`password`・`passphrase`・`secret`・`token`・`apikey`・`authorization`・`credential`・`cookie`・`session`)、もう1つはルート自身の `redact` メタデータです。

```ts
router
  .post('/integrations', { body: CreateIntegrationSchema }, [IntegrationController, 'store'])
  .name('integrations.store')
  .agent({
    description: 'Connect an external integration.',
    redact: ['webhookUrl'],
  })
```

一致判定は意図的に大雑把で、安全な側に倒してあります。

- キーは、小文字化して区切り文字を除いた名前が断片を**含む**ときに一致します。したがって `apiKey`・`api_key`・`x-api-key` はいずれも `apikey` ひとつでカバーされます
- 同じ包含判定が自分で宣言したエントリにも適用されるため、`redact: ['id']` は `userId` もマスクします
- 値の形より先にキーが決めます。`token` という名前のキーの下にあるネストしたオブジェクトは、走査されずまるごとマスクされます

マスクされた値は `[REDACTED]` に置き換えられます。走査は必ず終わります。循環は `[Circular]` に、極端に深いペイロードは `[Truncated]` になります。これは「何かが起きた」ことを記録している最中に走る処理であり、ルート自身の検証より前に取られた拒否も含むためです。

## dev MCP は別のエンドポイントです

Guren は以前から MCP エンドポイントを提供していますが、それはこのエンドポイントではありません。2つは区別してください。

| | dev MCP | アプリ MCP |
|---|---|---|
| パス | `/_guren/mcp` | `/mcp`(設定可能) |
| 提供元 | フレームワーク本体 | `@guren/plugin-mcp` |
| 操作対象 | ディスク上のプロジェクト | アプリケーションのデータ |
| 想定利用者 | 自分のコーディングエージェント | ユーザーがアプリに向けるエージェント |
| ゲート | `GUREN_MCP=1` **かつ**検証済みの loopback ピア。fail-closed | bearer トークン、次にそのツールスコープ |
| ツール | フレームワーク固定のツール(context・checks・scaffolding) | `.agent()` を付けたルート |
| 本番環境 | 存在しない。ゲートは各デプロイプラグインがバンドル時に確定させる | マウントされる |

`GUREN_MCP=1` で動かしている開発サーバーの前にトンネルを置いてはいけません。このエンドポイントはプロジェクトにファイルを書き込めます。開発側の話は[スペック起点の開発](./spec-anchored.md)を参照してください。

## チェックが守るもの

これらのルールは通常の `bunx guren check` スイートで実行され、内容によって有効化されます。エージェントルートのないアプリでは findings は生成されず、コントローラの走査も行われません。

`check` が **failure** とするのは、名前のないエージェントルート、MCP の文法から外れたツール名、フレームワークが予約しているツール名(`guren.preflight`)、同じツール名に解決される2つ以上のルート、そしてミドルウェアチェーンに認可 capability がなくアクションでも `this.authorize(...)` を呼んでいない read-only でないツールです。

`check` が **warn** するのは、出力の形がないこと、Inertia レスポンス、`body` スキーマのないボディ付きルート、アクションが変更を伴う read-only ツール、そして判定に到達できなかった場合(インラインハンドラ、読み取れなかったコントローラファイル、同名のコントローラクラスが2つある場合)です。

`bunx guren audit` は同じルートをより厳しく扱います。通常のルートでは warning になるボディ検証の finding が、エージェント公開ルートでは **failure** になり、レコードを削除・更新・force-write するアクションの `destructiveHint: false` は warn になります。

finding key の一覧は [CLI: エージェントに公開したルート](./cli.md#エージェントに公開したルート)にあります。

## 関連

- [ルーティング: エージェントツール](./routing.md#エージェントツール): 他のルートコントラクトの中で `.agent()` がどこに位置するか
- [API トークン](./api-tokens.md): MCP エンドポイントが bearer を検証する相手のストア
- [認可](./authorization.md): principal が何をしてよいかを決めるポリシー
- [イベント](./events.md): リスナーの登録方法とイベントマネージャ
- [CLI](./cli.md): `tool:list`・`tool:inspect` と check・audit の finding key

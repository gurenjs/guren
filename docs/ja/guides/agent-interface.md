# エージェントインターフェース

AI エージェントは MCP を通じてアプリケーションを呼び出します。Guren では、エージェント向けにアプリケーションをもう 1 つ書く必要はありません。エージェントツールは、**ルートがすでに持っているコントラクトから導出**されます。ルートの `params`・`query`・`body` スキーマがツールの入力スキーマに、`output` スキーマがツールの出力スキーマに、ミドルウェアチェーンが検査するポリシーがツールの認可になります。

ツールクラスを書く必要も、2 つ目の JSON Schema を書いて同期を保つ必要もありません。スキーマは 1 つしかないので、エンドポイントが検証しない形をツールが公開してしまうこともありません。ツールが呼ばれると、その呼び出しは本物の HTTP リクエストとしてアプリケーションにもう一度入ってきます。そのため、検証もミドルウェアもポリシーも、普段と同じ場所でちょうど 1 回ずつ実行されます。

ツールとして公開するかどうかは、ルートごとに明示して選びます。宣言しない限り、どのルートもツールにはなりません。

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

アプリケーション側で変更するのはこれだけです。ここから先では、こうしてできたツールを確認し、公開し、守りを固めるまでを順に説明します。

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

`tool:inspect` を使うと、1 つのツールの導出結果をすべて確認できます。マージされた入力、出力スキーマ、認可の ability、アノテーション、そのツールに当てはまる警告が表示されます。

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

どちらのコマンドも、生成済みのファイルは読まず、その場でルートグラフから導出します。そのため、`.guren/agents.gen.ts` がなかったり古かったりしても正しい結果が出ます。どちらも `--json` を付けると、導出結果をそのまま出力します。

`bunx guren codegen` を実行すると、ツールを 1 つ以上公開しているアプリでは同じ導出結果が `.guren/agents.gen.ts` に書き出され、1 つも公開していないアプリではこのファイルが削除されます。[CLI: エージェントツールコマンド](./cli.md#エージェントツールコマンド)も参照してください。

## 自分でツールを呼ぶ

`tool:list` はエージェントから何が見えるかを示すだけですが、`tool:call` を使うと実際にツールを呼べます。MCP クライアントもトークンも、起動中のサーバーも必要ありません。

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

このコマンドはアプリケーションを起動し、MCP クライアントからの呼び出しとまったく同じ経路でディスパッチします。ツールは `deriveAgentTools` で解決され、HTTP リクエストはフレームワーク自身のディスパッチャが組み立て、レスポンスも同じ処理で変換されます。CLI 専用の経路はどこにもないので、どのツールに解決されるか、どんなリクエストになるか、どんな結果が返るかは、エージェントが呼んだ場合と同じです。

違うのは、呼び出し元が誰なのかを示す方法だけです。MCP クライアントは bearer トークンを提示します。このトークンはリクエストを組み立てる前にスコープを検査され、cookie を持たないので CSRF 検証もスキップされます。一方の `tool:call` は `--as` で認証し、ブラウザと同じ手順で CSRF トークンを取得します。そのため `tool:call` が成功して分かるのは、そのツールが動くことだけです。特定のトークンがそのツールに届くスコープを持っているかどうかは分かりません。それを決めるのは `guren token:issue` です。

ツールの一覧は、起動したアプリのルートグラフから取り出します。`--routes` フラグがないのはこのためです。ルートファイルを差し替えても稼働中のアプリが提供するものは変わらないので、そのようなフラグがあると、名前は指定できるのに届かないツールができてしまい、フラグがない場合より悪い結果になります。カレントディレクトリ以外のアプリを対象にするときは `--app <dir>` を使います。

存在しない名前を渡すと、存在するツールの名前が一覧で返ります。呼び出しが失敗したときは、アプリケーション自身が返した失敗をそのまま報告し、0 以外の終了コードで終わります。

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

`--as user:42` を付けると、そのユーザーとして呼び出します。プロセスに `GUREN_TESTING=1` を設定し、アプリが本物の資格情報の代わりに注入されたユーザーを受け入れるようにしています。`@guren/testing` と同じ仕組みです。このフラグを渡すと、毎回その旨の警告が表示されます。

信頼境界は `bunx guren console` と同じです。実行する人はもともとこのプロジェクトでコードを実行できる、という前提の開発用フラグなので、共有環境や本番のデータベースに対しては実行しないでください。

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

リクエストはルートのミドルウェアを通り、ツールが公開しているコントラクトで検証されてから、ハンドラーの手前で止まります。`unverified` に並ぶのは、本当の呼び出しであればこの先でまだ評価されるものです。たとえばアクションの中で認可しているルートの場合、その認可はこの継ぎ目からは仕組み上たどり着けません。

**予行演習は、リクエスト全体のドライランとは違います。** 継ぎ目はいちばん最後に置かれています。手前のゲートがすべて本物であるからこそ判定(verdict)に意味があるのですが、その代わり、ルートのミドルウェアは実際に動いています。クォータを加算する、レート制限の枠を消費する、セッションに触れる、外部を呼ぶといったミドルウェアの副作用は、すでに起きています。スキップされるのはハンドラーだけです。

MCP からは、フラグではなく専用のツールを使って同じ継ぎ目に届きます([MCP 経由で呼び出しを予行演習する](#mcp-経由で呼び出しを予行演習する))。`outputSchema` を公開するツールは、それに合った `structuredContent` を返さなければなりません。判定はどのルートの出力の形にも合わないので、判定を返すための専用ツールが必要になります。`tool:call` と `@guren/testing` はこの制約を受けないので、呼び出しそのものに対して判定を求められます。

## ツールをテストする

`app.agent()` を使うと、テスト対象アプリのツールを MCP と同じディスパッチ経路で呼べます。

```ts
import { TestApp } from '@guren/testing'

const app = await TestApp.create({ routes: registerWebRoutes })

const result = await app.agent().call('posts.store', { title: 'Hello' }, { as: user })
result.assertOk()

const post = result.assertStructured<{ id: number; title: string }>()
expect(post.title).toBe('Hello')
```

ほかの `TestApp` のリクエストと同じように、呼び出しにそのままアサーションをつなげて書くこともできます。

```ts
await app.agent().call('posts.index').assertOk()
await app.agent().call('posts.store', { title: 'no' }).assertStatus(422)
await app.agent().call('secret.show').assertDenied()
```

| アサーション | 成功する条件 |
|-------------|-------------|
| `assertOk()` | 呼び出しがエラー結果として返らなかった(2xx か 3xx のステータス) |
| `assertStatus(code)` | ディスパッチの結果がちょうどその HTTP ステータスだった |
| `assertDenied()` | アプリケーションが `401` または `403` を返した |
| `assertStructured<T>()` | ツールがオブジェクトの出力スキーマを公開していて、そのとおりのオブジェクトを返した。await するとペイロードそのものが返ります |

`await app.agent().tools()` を使うと、アプリが公開するツールを、`tool:list` と同じ導出で一覧にできます。

知っておきたい点が 3 つあります。

- **`{ as: user }` は `actingAs(user)` と同じです。** `X-Testing-User` のエンベロープを使います。ここではトークンを使わないので、`assertDenied()` が示すのは「アプリケーションが拒否した」ことだけで、理由が認証なのか認可なのかは分かりません。bearer のスコープは MCP エンドポイント側の仕組みなので、テストからは届きません。`requireAuthenticated({ redirectTo: '/login' })` の後ろにあるルートを `{ as }` なしで呼ぶと、リダイレクトではなく `401` が返ります。
- **CSRF を用意するか外すかは、意識して選んでください。** ディスパッチされたツール呼び出しは cookie も bearer も持っていないので、`auth` 付きで作ったアプリでは、更新系の呼び出しがポリシーに届く前に `403` で拒否されます。この拒否は、`assertDenied()` ではポリシーによる拒否と区別できません。`(await app.withCsrf()).agent()` を通して呼ぶか、CSRF を組み込んでいないアプリでテストしてください。
- **アプリがルートグラフを持っている必要があります。** `TestApp.create({ routes })` と `TestApp.fromApp(app)` なら持っています。`TestApp.fromFetch()` と `TestApp.fromWorkers()` は素の fetch 関数を受け取るだけなのでルートグラフがなく、この場合 `agent()` は「ツールが 0 件」と答える代わりに、どのコンストラクタを使えばよいかを教えてくれます。

`{ preflight: true }` もここで使えて、`tool:call` と同じ判定が返ります。

```ts
const result = await app.agent().call('posts.store', { title: 'x' }, { preflight: true })
result.assertOk()
expect(result.json<{ allowed: boolean }>().allowed).toBe(true)
```

## `.agent()` を宣言する

書き方は 2 通りあり、どちらも意味は同じです。ルートのほかの記述と並べて読みやすいほうを選んでください。

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

ルーターは、登録の時点で次の 2 つのルールを守らせます。

- **オプションオブジェクトは第 2 引数、ハンドラーは最後の引数に置きます。** `router.post(path, options, handler)` の形です。ルーターはオプションオブジェクトかどうかをキーで判別していて、`agent` もその判別に使うキーの 1 つです。そのため、`agent` だけを持つオブジェクトもハンドラーではなくオプションとして扱われます。
- **宣言は 1 回だけにします。** ルートオプションの `agent` と `.agent()` のチェーンを両方書くと、例外が投げられます。2 つをマージする仕様にすると、採用されなかったほうの宣言に書かれたセキュリティ上重要なフィールド(`approval`・`redact`)が、何の知らせもなく消えてしまうからです。

**ツール名には、ルート名がそのまま使われます。** MCP のツール名の文法(`^[A-Za-z0-9._-]{1,128}$`)ではドットが使えるので、`posts.store` はツール名として正しい形です。ただし、すべてのクライアントがこの名前を受け付けるわけではありません。Claude と OpenAI のツール API は名前を `^[A-Za-z0-9_-]{1,64}$` に限っていて、Claude Managed Agents は MCP ツールにも同じ文法を当てはめ、合わないツールを読み飛ばします。アプリ側からは、この読み飛ばしに気付けません。`tools/list` には正しく応答していて、クライアントがその項目を捨てているだけだからです。こうしたルートには、`agent: { toolName: 'posts_store' }` のように、どのクライアントでも受け付けられる綴りを指定してください。ルート名、`route()` ヘルパー、HTTP パスはそのままで、公開されるツール名だけが変わります。クライアントに捨てられるツール名があると、`guren check` が警告を出します。

`toolName` で変えられるのは綴りだけで、名前が必要なことは変わりません。名前がツールの識別子なので、`.name()` のないルートはツールにできず、`guren check` が失敗として報告します。

### リソースルート

`resource()` には、アクションごとにメタデータを渡します。**列挙しなかったアクションは公開されません**。

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

既定で公開しないことに意味があります。すべてのエンドポイントを自動でツールにするのはよく知られたアンチパターンで、ツールのカタログが膨れ上がり、それを読むエージェントの性能が落ちます。エージェントが本当に必要とする少数のルートだけを公開してください。なお、その `resource()` 呼び出しで登録されないアクション(`only`・`except` で除外したものや、コントローラにないもの)にメタデータを宣言すると、例外が投げられます。存在しえないツールのメタデータは、黙って無視してよい記述ではなく、配線の誤りとして扱います。

### メタデータのフィールド

| フィールド | 意味 |
|-------|---------|
| `description` | ツールが何をするか。省略すると、ルートの OpenAPI の `description`、それもなければ `summary` が使われます。このアプリを見たことのないエージェントが読むつもりで書いてください。 |
| `toolName` | ルート名の代わりに使うツール名。ドットを含むルート名に、どのクライアントでも受け付けられる綴り(`posts_store`)を付けるときに使います。 |
| `expose` | `{ mcp?, webMcp? }` で、ツールをどのプロトコルに公開するかを指定します。どちらも既定は true です。`expose: { mcp: false }` にすると MCP エンドポイントに出なくなり、`expose: { webMcp: false }` にすると `@guren/plugin-webmcp`(実験的)が登録するブラウザ側の一覧に出なくなります。 |
| `readOnlyHint` | ツールが何も変更しないことを示します。[アノテーション](#アノテーション)を参照してください。 |
| `destructiveHint` | `false` は「追加しかせず、既存のものを壊さない」という強い宣言です。 |
| `idempotentHint` | 同じ引数で何度呼んでも、2 回目以降は何も変わらないことを示します。 |
| `approval` | `'required'` を付けると、呼び出しはすぐには実行されず、人の承認を待つ申請になります。[承認が必要なツール](#承認が必要なツール)を参照してください。承認キューを設定していない場合、MCP エンドポイントは安全側に倒し(fail-closed)、ツールを一覧にも出さず、呼び出しも受け付けません。 |
| `redact` | 監査ログでマスクする引数のフィールド名。[監査ログ](#監査ログ)を参照してください。 |

## 入力スキーマ

MCP ではツールの入力を 1 つのオブジェクトにする必要があるので、ルートの `params`・`query`・`body` はこの順に 1 つにマージされます。

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

- **パスパラメータは常に必須です。** パスで宣言されていて `params` スキーマに書かれていないパラメータは、必須の文字列として補われます。スキーマに書かれているパラメータも、スキーマの内容にかかわらず必須のままです。パラメータがないと URL を組み立てられないからです(既知の制限: Hono のオプション修飾子を使った `/posts/:id?` も必須として提示されます。OpenAPI ドキュメントでも同じ扱いです)。
- **オブジェクトでない body は 1 段下に入ります。** `body` が配列、プリミティブ、ユニオン、レコードのいずれかの場合は、平らに展開されず、`body` という 1 つのプロパティの下に置かれます。ツールの入力は、いちばん外側がオブジェクトでなければならないからです。
- **キーが重なったときは、マージせずに報告します。** 2 つのソースが同じキーを宣言していると、あとのほう(params → path → query → body の順)が採用され、導出時に両方を名指しした警告が出ます。この警告は `tool:list`、そのツールの `tool:inspect`、MCP プラグインが起動したときのサーバーログに表示されます。マージされたツールの入力では名前空間が 1 つしかないので、どちらかの名前を変えてください。
- **提示される型は、スキーマの入力側の型です。** `z.coerce`・`.default()`・`.transform()` は、コントローラが受け取る型ではなく、エージェントが*書く*側の型として表示されます。実際の検証はこれまでどおり、アプリケーションの境界で 1 回だけ行われます。

ボディを受け取るルートに `body` スキーマがないと、入力はパスとクエリだけから導出されるので、エージェントはペイロードの形を推測するしかなくなります。この場合は `guren check` が警告を出します。

## 出力

出力の形は、次の 3 段階の優先順位で決まります。

| 優先度 | 供給元 | ツールが得るもの |
|---|---|---|
| 1 | ルートの `output` スキーマ | JSON Schema の `outputSchema` と、成功呼び出しごとの `structuredContent` |
| 2 | [`resource` ヒント](./routing.md#resource-レスポンスヒント) | スキーマはなし。`bunx guren codegen` が Resource から取り出した型をテキストとしてツールの説明文に埋め込みます |
| 3 | どちらもなし | 出力の形はまったく提示されません。`guren check` が警告します |

両方が宣言されている場合は `output` が優先されます。実行時に検証される形は `output` スキーマだけです。両方を持たせると、1 つのレスポンスに 2 つの記述ができ、その 2 つが食い違わないように保つ仕組みがなくなってしまいます。

`structuredContent` が付くのは、`outputSchema` が**オブジェクト**の場合だけです。MCP ではオブジェクト以外をいちばん外側の型にできません。`output` が配列やプリミティブのルートは構造化された出力を提示せず、結果はテキストとして返ります。

レスポンスは、次の表のようにツールの結果に変換されます。

| レスポンス | 結果 |
|---|---|
| 2xx JSON | テキストにシリアライズされ、ツールがオブジェクトの出力スキーマを提示している場合は `structuredContent` も付きます |
| 2xx の Inertia ページ JSON | `page.props` を取り出して返します。出力スキーマを持たないツールだけが対象なので、提示した形と結果が食い違うことはありません |
| 204 / 3xx | ステータスと `Location` を示す 1 行のテキスト。エラーにはなりません |
| 4xx / 5xx | `isError: true` と一緒に、例外ハンドラーの JSON ボディが入ります。422 の `{ message, errors }` はプロトコルの障害ではなく、エージェントが読むべきアプリケーションの失敗です |
| JSON でないもの | 長さに上限のあるテキスト |

この表より優先されるルールが 1 つあります。オブジェクトの出力スキーマを提示しているツールのルートが、そのスキーマを満たせないもの(204、リダイレクト、JSON 配列、JSON でないボディ)を返した場合は、成功ではなく、食い違いの内容を示すエラー結果になります。成功として返すと、ルートがすでに実行されたあとでクライアントに拒否されてしまうからです。

フレームワークの認証ガードは、ツールに対してリダイレクトを返しません。`requireAuthenticated`、`requireGuest`、`requireVerifiedEmail` は、ディスパッチャーが組み立てたリクエスト(`X-Guren-Agent-Surface` ヘッダーを持ちます)を見分け、ブラウザなら `redirectTo` に送る場面で JSON を返します。ユーザーがいなければ `401`、ゲスト専用のルートにログイン済みのユーザーが来た場合とメールアドレスが未確認の場合は `403` です。そのため呼び出しは、`/login` を指す成功ではなく、エラー結果として返ります。このヘッダーが変えるのは拒否の返し方だけで、何かを許可するものではありません。`store` が `this.redirect('/posts')` を返す場合のように、ハンドラー自身が返すリダイレクトはこれまでどおり成功です。

`createForceHttpsMiddleware()` も、ツールの呼び出しは https にリダイレクトせずに通します。アプリにもう一度入るリクエストは、呼び出し元がアクセスしたオリジンで組み立てられます。TLS を終端するプロキシの後ろにある MCP エンドポイントなら `http://`、durable agent、`guren tool:call`、`TestApp.agent()`、`APP_URL` のないプロセス内 AI エージェントなら `http://localhost` です。このリクエストはプロセスの外に出ないので、https に切り替えるべき通信路がそもそもありません。上の認証ガードとは違い、このミドルウェアはヘッダーを見ません。通すのはディスパッチャーが組み立てたリクエストオブジェクトだけなので、同じヘッダーを付けた外部からの HTTP リクエストはリダイレクトされます。

`this.inertia(...)` で応答するアクションは、ページがコンポーネントに渡している内容をそのまま返します。この形は何にも検査されず、UI を変えただけで簡単に変わってしまいます。エージェント向けのルートでは `output` と `this.json(...)` を使ってください。Inertia で応答している場合は `guren check` が警告を出します。

## アノテーション

MCP のアノテーションは、ツールの性質をクライアントに伝えるためのものです。Guren は 3 つのアノテーションすべてを明示的な値に決めてから渡すので、受け取る側で既定値を補い直す必要はありません。

| アノテーション | 既定値 |
|---|---|
| `readOnlyHint` | GET と QUERY は true、それ以外は false |
| `destructiveHint` | `readOnlyHint` の逆。読み取り専用でないツールに対する MCP 仕様の既定値は `true` です |
| `idempotentHint` | GET・QUERY・PUT・DELETE は true |

**アノテーションはクライアントの UX のためのヒントで、何も強制しません。** 実際に強制するのは、ポリシー(ブラウザからのリクエストとまったく同じく、ディスパッチされたリクエストの中で評価されます)と、トークンのスコープ(リクエストを組み立てる前に評価されます)です。そのため、検査を*ゆるめる*方向の 2 つの宣言については、コントローラの本体と突き合わせて確かめます。

- `readOnlyHint: true` を付けたルートは認可のルールから外れるので、読み取り専用のツールのアクションがレコードを削除、更新、force-write していると `guren check` が警告します。自分で書いたヒントだけでなく、GET・QUERY の既定値も同じように扱います。
- `destructiveHint: false` は「追加しかしない」という宣言なので、アクションが削除、更新、force-write していると `guren audit` が警告します。

### 認証は認可ではありません

エージェントはブラウザのセッションではなく、トークンを使って呼び出します。`this.auth.userOrFail()` で確かめられるのは呼び出し元が*誰か*だけで、その呼び出し元が*このアクションを*実行してよいかまでは判断しません。読み取り専用でないツールを認証だけで守っていると、何らかのトークンを持つ呼び出し主体(principal)であれば誰でも、そのアクションを丸ごと実行できてしまいます。

そのため、読み取り専用でないツールには、次のどちらかが必要です。

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

`this.can(...)` では足りません。真偽値を返すだけで、何も強制しないからです。読み取り専用でないエージェントルートにどちらもない場合、`guren check` は**失敗**(failure)として報告します。

## ツールを公開する

ツールの配信は `@guren/plugin-mcp` が受け持ちます。エージェントにツールを公開しないアプリに MCP のトランスポートまで入らないよう、別のパッケージに分けてあります。

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

エンドポイントは `/mcp` にマウントされ、ステートレスな streamable HTTP で通信します。リクエストごとに MCP サーバーを 1 つ作るので、保持しておくセッションはありません。MCP 2026-07-28 のクライアントにも、2025 年版（2025-11-25 以前）の `initialize` ハンドシェイクで接続してくるクライアントにも、同じパスで応答します。**bearer 認証は必須**なので、アプリで [API トークン](./api-tokens.md)のストアを設定しておく必要があります。

- bearer がない、または無効・期限切れ・失効している場合: MCP のメッセージを処理する前に、`401` と `WWW-Authenticate: Bearer` を返します
- トークンストアがまったく設定されていない場合: `auth.useTokens(store)` を名指しした `500` を返します。トークンが拒否されたように見せず、設定の誤りだと分かるようにするためです
- 認証済みの `GET` または `DELETE`: 開いたり閉じたりするセッションのストリームがないので、`405` を返します
- 認証済みの `POST` で `Content-Type` が `application/json` でない場合: `415` を返します
- `subscriptions/listen` リクエスト: JSON-RPC エラーを返します。実行中にツールの一覧が変わることはないので、ストリームを開いたままにしても送るものがありません

このエンドポイントのために CSRF の除外設定を書く必要はありません。`Authorization: Bearer` を持ち、`Cookie` ヘッダーをまったく持たないリクエストは、フレームワーク全体で CSRF 検証がスキップされます。cookie による暗黙の権限(ambient authority)がないので、守る対象がないからです。ディスパッチャが組み立てる bearer リクエストも、仕組み上 cookie を持ちません。

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
| `serverInfo` | `{ name: 'guren-app', version: '1.0.0' }` | クライアントに伝えるサーバーの識別情報 |
| `rateLimit` | `{ max: 60, writeMax: 20, windowMs: 60_000 }` | トークンごとの呼び出し回数の上限。`false` で無効 |
| `updateLastUsed` | `true` | bearer を検証したときにトークンの `lastUsedAt` を更新するかどうか |
| `approvals` | なし | 承認キュー。`{ store, notify, ttlMs? }` を渡します。[承認が必要なツール](#承認が必要なツール)を参照 |

レート制限のキーは IP ではなく**トークン ID** なので、上限は資格情報ごとにかかります。制限はプロセスのメモリ上で数えるため、常駐サーバーが 1 台なら正確に効きますが、複数のインスタンスやサーバーレスではインスタンスごとの制限になります。全体で 1 つの上限を設けたい場合は、共有のストアとアプリ自身の[レート制限ミドルウェア](./rate-limiting.md)が必要です。

> エージェントルートにアプリ自身のレート制限ミドルウェアを置いても、この制限の代わりにはなりません。そのミドルウェアの既定のキーはソケットの接続元から作られますが、アプリにもう一度入るリクエストはソケットを通っていないので、MCP の呼び出し元がすべて、そのルートの共有バケット 1 つにまとめられてしまいます。

### MCP 経由で呼び出しを予行演習する

エンドポイントには、エンドポイント自身が提供するツールが 1 つだけ追加されます。それが `guren_preflight` です。このツールは、ほかのツールへの呼び出しが許可されるかどうかを答えるだけで、その呼び出し自体は実行しません。

```json
{
  "name": "guren_preflight",
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

たどり着く先は、`--preflight` と同じ継ぎ目です。確認対象のツール自身のミドルウェアが動き、公開しているコントラクトで検証されたあと、ハンドラーの手前でリクエストが止まります。アクション自体は実行されませんが、ミドルウェアは実際に動くので、ミドルウェアの副作用は起きます。

拒否されても、結果は error ではなく **success** になります。呼び出し元が尋ねているのは「この呼び出しは許可されるか」なので、「いいえ、理由はこれです」もその問いへの正常な答えだからです。

```json
{
  "tool": "posts.store",
  "allowed": false,
  "status": 422,
  "message": "The given data was invalid.",
  "errors": { "title": ["Required"] }
}
```

`validated` と `unverified` が含まれるのは、リクエストが継ぎ目までたどり着いたときだけです。それより手前で認証や認可のミドルウェアに拒否された場合は、たどり着かなかったチェックについて何も言えないので、空の配列にするのではなく、フィールドごと省きます。

覚えておきたい規則が 4 つあります。

- **ツールを確認するには、そのツールを呼ぶのと同じスコープが必要です。** そうしないと、呼べないツールの認可の仕組みを探る手段になってしまいます。付与されていない名前を指定すると、直接呼んだときと同じように error の結果で拒否されます。
- **承認が必要なツールも確認できます。** 承認が必要なツールは呼び出せず、一覧にも出ません。だからこそ「承認されれば通るのか」を事前に確かめる意味があり、予行演習なら何も実行されません。
- **`guren_preflight` が一覧に出るのは、ツールを 1 つ以上付与されたトークンだけです。** 何も呼べないトークンには、予行演習する対象がないからです。
- **この名前は予約されています。** `.agent()` のツール名にこの名前を使ったルートは `bunx guren check` で失敗になり、エンドポイントもそのルートを公開しません。同じ名前のツールが 2 つあると、MCP クライアントはツールのカタログ全体を受け付けなくなります。

予行演習は申請とは別のものです。承認が必要なツールを予行演習しても、申請は作られず、承認者に通知も届きません。

## 承認が必要なツール

操作によっては、エージェントに求められたというだけで実行させたくないものがあります。ルートに印を付けると、呼び出しは実行されず、人への申請に変わります。

```ts
router
  .delete('/posts/:id', { params: PostIdParamSchema }, [PostController, 'destroy'])
  .name('posts.destroy')
  .agent({ description: 'Delete a post.', approval: 'required' })
```

最初の呼び出しは拒否されます。何も実行されずに承認待ち(pending)の申請が作られ、承認者に通知が届き、エージェントには申請 ID が返ります。

```json
{
  "status": "pending",
  "requestId": "8f0c…",
  "tool": "posts.destroy",
  "requestedAt": "2026-09-01T12:00:00.000Z",
  "expiresAt": "2026-09-01T13:00:00.000Z",
  "executed": false,
  "pollWith": "guren_approval_status"
}
```

人がその申請を承認したあと、エージェントが**同じ引数で同じ呼び出しをもう一度行う**と、今度は 1 回だけ通ります。もう一度呼び出すのは呼び出し側の役目です。アプリケーション自身がホストしている永続エージェントなら、専用の永続台帳をもとに自動で再実行されます([永続エージェント](./durable-agents.md)を参照)。

### キューを設定する

既定のストアはありません。承認待ちの申請をどこに保存するかは、アプリケーション側で決めます。監査ログの出力先に既定値がないのと同じ理由です。このエンドポイントは Workers や Lambda でも動くので、フレームワークが黙ってプロセスのメモリに保存してしまうと、次の isolate が知らない申請を承認してしまいかねません。

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
| `create(request)` | 新しい承認待ちの申請を保存する |
| `find(id)` | その ID の申請を返す。なければ `null` |
| `findMatch({ tool, fingerprint, principalKey })` | この呼び出しに一致する**未消費**の申請を返す。状態は問わず、複数あれば最新のもの |
| `consume(id)` | 承認を消費し、*この*呼び出しが承認を使えたかどうかを返す |

実装では、次の 2 つを必ず守ってください。

- **`consume` は compare-and-set にします。** `consumedAt` がまだ空のときだけ書き込み、すでに値が入っていたら `false` を返します。同時に来た 2 つの呼び出しは同じ承認済みのレコードを見つけるので、無条件に書き込む実装では両方に承認を渡してしまいます。
- **`findMatch` では、期限でも状態でも絞り込みません。** その判定はフレームワークが行います。ストアでも判定すると同じ規則の写しが 2 つできてしまい、しかも危険な方向に壊れます。比較を 1 つ書き忘れただけで、先月の承認が今日の呼び出しを通してしまうからです。

`notify` には申請が渡されるだけで、誰に知らせるかはアプリケーションが決めます。フレームワークには承認者の一覧が見えないので、宛先を選べません。よくある使い方のために `AgentApprovalRequested` を用意してあります。これをサブクラス化しても、まったく別のものを送っても構いません。申請は `notify` を呼ぶ**前**に保存され、`notify` の完了を待ってから応答することもありません。メールの送信経路が落ちていても、失われるのは通知 1 通だけで、申請も呼び出しも残ります。送信の失敗は申請 ID と一緒にログに出ます。レスポンスを返した時点でまだ送信中の通知も、途中で打ち切られません。Workers ではその Promise をリクエストの `waitUntil` に渡すので、Webhook や SMTP のやり取りも最後まで完了します。

申請を承認または却下するのはアプリケーション側の役目で、保存先もアプリケーションのものです。`status` を `'approved'` か `'rejected'` にし、`resolvedAt` と `resolvedBy` を書き込みます。フレームワークに `approve()` はありません。承認は、フレームワークからは見えない画面で人が行う操作だからです。

### ゲートが強制する規則

- **承認は引数に結び付いています。** `posts.destroy {id: 5}` を承認しても、`{id: 9}` は許可されません。キーの順序やネストの順序は一致の判定に影響しませんが、型は影響します。`{id: 5}` と `{id: '5'}` は別の呼び出しです。判定には**生の引数**を正規化した SHA-256 を使い、保存されるのはそのハッシュと redaction 済みの引数だけです。そのため、キューが秘密情報のもう 1 つの保存場所になることはありません。
- **承認は 1 回限りで、期限があります。** 一度通ったら、次の呼び出しにはまた新しい申請が必要です。`expiresAt` を過ぎたレコードは何も許可しません。
- **承認は呼び出し元に結び付いています。** 引数が同じでも、別の呼び出し主体に対する承認では通りません。
- **承認はディスパッチの前に消費されます。** そのあとで呼び出しが失敗しても、消費済みのままです。破壊的な操作が 1 回の承認で 2 回実行されるより、もう一度承認してもらうほうが安全だからです。
- **承認待ちの呼び出しを繰り返しても、申請は増えません。** 同じ申請 ID が返り、承認者への通知も 2 回目は送られません。
- **却下された呼び出しは、再び申請されません。** 拒否の応答には `"status": "rejected"` が入るので、エージェントはポーリングを続けて待つ意味がある状態と区別できます。レコードの期限が切れたあとは、新しい申請として扱われます。

### `guren_approval_status`

キューを設定すると、エンドポイントにはエンドポイント自身のツールがもう 1 つ追加されます。拒否の応答に入っていた `requestId` を渡してください。

```json
{ "name": "guren_approval_status", "arguments": { "requestId": "8f0c…" } }
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

状態を読むだけでは何も実行されません。`"approved"` は「今もう一度呼んでよい」という意味です。`guren_preflight` と同じくトークンの読み取りの上限を消費するので、短い間隔でポーリングし続けると制限にかかります。

状態を読めるのは、**自分が作った**申請だけです。別の呼び出し主体の申請 ID を渡すと、存在しない ID とまったく同じ答えが返ります。そうしないと、同僚がどんな承認を待っているかを調べ上げる手段になってしまうからです。呼び出し元に見せない区別は、監査ログのほうに残ります。状態の確認も、`guren_approval_status` として記録される通常の呼び出しです。

`bunx guren check` は、`mcpPlugin({ … })` の呼び出しを読み取れて、その中に `approvals` がない場合、`approval: 'required'` を宣言したルートを失敗にします。キューがなければ、そのツールは守られているのではなく、単に呼び出せないだけだからです。

## トークンとスコープ

**既存の `['*']` トークンでは、エージェントツールは 1 つも使えません。** ツールのスコープとして読まれるのは `tool:` と `tools:` の ability だけで、それ以外の ability は、`ApiToken` の既定値である `['*']` も含め、どれにも一致しません。これは意図した設計です。アプリで最初の `.agent()` ルートを宣言した途端に、エージェントツールができる前に発行したすべてのトークンがエージェント向けのツール全体を使えるようになる、という事故を防ぐためです。エージェント向けのツールへのアクセスは、明示的に付与するか、まったく付与しないかのどちらかです。

スコープの形は次の 4 つだけです。

| スコープ | 付与する範囲 |
|---|---|
| `tool:posts.store` | そのツール 1 つだけ |
| `tools:read` | 最終的な `readOnlyHint` が true のツールすべて |
| `tools:posts.*` | `posts.…` という名前のツールすべて(ドットも一致の条件に含まれるので、`posts` という名前のツールは含まれません) |
| `tools:*` | すべてのツール |

スコープは足し合わせる方式で、拒否を表す書き方はありません。トークンのスコープに含まれないツールは、呼び出しを拒否されるだけでなく、**`tools/list` にも表示されません**。付与されていないツールまで一覧に出すと、読み取り専用のエージェントに書き込み系ツールの全体像を教えてしまうからです。

### OAuth クライアントが要求するスコープ

このスコープの文法は MCP 仕様ではなくアプリケーション独自のものなので、一般的なクライアントには推測できず、スコープを何も送ってきません。そこで `guren cloudflare:build --mcp-oauth` で生成した worker は、仕様がクライアントに読むよう求めている 2 か所で、受け付けるスコープを提示します。401 チャレンジの `WWW-Authenticate` に含める `scope` と、Protected Resource Metadata(RFC 9728)です。どちらにも `tools:read` を載せます。

ここにあえて大まかな read スコープを載せているのには理由があります。仕様に従うクライアントはこのフィールドに並ぶスコープをすべて要求しますし、このフィールドには基本的な機能に必要な最小限のスコープを載せることになっています。ここに `tools:*` を並べると、すべてのクライアントがツール全体へのアクセスを要求してしまいます。範囲の広い `tools:*` は、authorization server metadata(RFC 8414)のほうに載せてあります。こちらはクライアントがスコープを *選ぶ* ときに読む文書ではないので、サーバーが何を受け付けるかを確認したい人向けの情報です。

これらを無視してスコープを送ってこないクライアントでも、既定値を当てはめた同意画面が表示されるので、空のページになることはありません。書き込み系のツールまで範囲を広げるにはそのツールの正確な名前が必要ですが、read だけを付与された状態では名前を知る方法がありません。付与範囲の外のツールは `tools/list` に表示されず、`guren_preflight` でも拒否されるからです。名前は `bunx guren tool:list` で確認し、`tool:<name>` を指定して認可をやり直してください。

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

書き込みも行うエージェントには、このトークンのスコープを広げずに、別のトークンを発行してください。

```bash
bunx guren token:issue --name blog-writer --user 42 --tools 'posts.store' --expires 30d
```

`--tools` には短縮形も使えます。名前だけを書くと `tool:<name>`、`posts.*` は `tools:posts.*`、`read` は `tools:read`、`*` は `tools:*` として扱われます。

| オプション | 意味 |
|---|---|
| `--name` | 必須。あとで失効させるときに、このトークンを見分けるための名前です。 |
| `--user` | 必須。トークンで認証されるユーザーの ID です。 |
| `--tools` | 必須。カンマ区切りのスコープです。 |
| `--read-only` | 付与するツールを読み取り専用のものに限ります。 |
| `--expires` | `30d`・`12h`・`45m` のように指定します。省略すると期限のないトークンになります。 |
| `--allow-unmatched` | 今はどのツールにも一致しないスコープも受け入れます。 |
| `--yes` | `tools:*` を指定するときに必要です。 |
| `--json` | 発行したトークンを JSON で出力します。警告も含まれます。 |

このコマンドは、警告で済ませるより拒否することを選びます。資格情報を扱うコマンドでのタイプミスは、画面を見ているうちに直すのがいちばん手間がかからないからです。

- **今どのツールにも一致しないスコープは拒否されます。** そうしたスコープは、タイプミスか*潜在的な付与*(latent grant)のどちらかです。潜在的な付与とは、一致するツールが追加された途端に、誰も同意していないのに有効になってしまう、保存済みのパターンのことです。`--allow-unmatched` を付ければ受け入れられますが、その場合はこの危険について警告が出ます。
- **`tools:*` には `--yes` が必要です。** アプリが今公開しているツールと、今後追加されるツールのすべてを付与します。破壊的な操作をするツールも含まれます。
- **`--read-only` では、具体的なツール名で保存されます。** 付与する範囲は発行時に展開され、パターンではなく `tool:<name>` のエントリとして保存されます。スコープの文法に「`posts.*` のうち読み取り専用のものだけ」という書き方がないからです。そのため安全側に倒れていて(fail-closed)、あとから `posts.` で始まる書き込み系のツールが追加されても、保存済みのエントリには含まれません。また `--read-only` を付けた場合、一致しないスコープは `--allow-unmatched` を付けても拒否されます。あとから何かが付与されることは、そもそもありえないからです。

発行時には次の 2 つの警告が出ることがあります。どちらも警告だけで、発行は拒否しません。

- 期限のないトークンは、誰かが手で失効させるまで有効なままです
- 読み取り系と書き込み系のツールを**両方**含むトークンは、これまでに知られているインジェクションの事例と同じ構成です。攻撃者の影響を受けたコンテンツを読み、しかも書き戻せるエージェントは、そのコンテンツに操られるおそれがあります。できれば 2 つのトークンに分けてください

## 監査ログ

ツールの呼び出しも拒否も、すべてフレームワークのイベントとして発行されます。すでにイベントをどこかに転送しているなら、同じ転送先に送れます。

| イベント | 発生するとき | 含まれる情報 |
|---|---|---|
| `AgentToolInvoked` | 呼び出しがアプリケーションに届いた | `principal`・`tool`・`arguments`・`status`・`durationMs`・`surface` |
| `AgentToolDenied` | HTTP リクエストを作る前にアダプタが拒否した | `principal`・`tool`・`arguments`・`reason`・`surface` |

`reason` は `'auth'`・`'scope'`・`'approval'`・`'rate-limit'` のいずれかで、それぞれリクエストの前に行う検査を指します。**ポリシーによる拒否は、この中に含まれません。** ポリシーはディスパッチされたリクエストの中で評価されるので、ステータスが `403` の `AgentToolInvoked` として届きます。拒否にはステータスも所要時間もありません。何も実行されていないからです。

`guren_preflight` の呼び出しも、ほかの呼び出しと同じように `tool: 'guren_preflight'` として記録されます。エージェントが「自分に何が許されているか」を探ったという事実は、監査ログにこそ残したい情報です。確認された側のツールについては、何も呼び出されていないので記録は残りません。拒否された場合も同じで、`guren_preflight` の `AgentToolDenied` として記録されます。確認された側のツール名で記録すると、予行演習が拒否されたのか、書き込み系ツールの本当の呼び出しが拒否されたのかを区別できなくなるからです。どのツールが確認されたかは、記録の引数(`tool`)に残ります。

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

イベントを発行するには、イベントマネージャがバインドされている必要があります。`mcpPlugin()` と一緒に `EventServiceProvider`(またはアプリ独自のイベントプロバイダ)を登録してください。登録していないと、プラグインは起動時に警告を出し、イベントを 1 つも発行しません。

### 監査ログを書き出す

イベントは、記録する仕組みがあってもなくても発行されます。記録を残しておきたい場合は、プラグインに出力先(シンク)を設定します。

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

指定したパスと同じディレクトリにある `agent-audit-YYYY-MM-DD.log` に、1 行 1 件の JSON レコードを追記し、ファイルは日ごとに切り替えます。切り替えのときに、`days` より古いファイルは削除されます(既定は 14 日)。`file` はファイルシステムがそのまま解決するので、絶対パスか、プロセスのカレントディレクトリからの相対パスを指定してください。アプリケーションのルートを基準には解決しません。

ファイル以外に書き出したいときは、関数を渡します。

```ts
mcpPlugin({
  audit: {
    sink: async (record) => {
      await auditStream.write(record)
    },
  },
})
```

シンクが例外を投げると警告が出ますが、記録しようとしていたツールの呼び出し自体は失敗しません。レスポンスを返した時点でまだ書き込み中のシンクも、途中で打ち切られません。Workers ではその Promise をリクエストの `waitUntil` に渡すので、D1 への書き込みも最後まで完了します。

シンクを設定すると、`bunx guren tool:call` の呼び出しも記録されるようになります。このコマンドはアプリケーションを起動するので、アプリで設定した監査ログをそのまま見つけて書き込みます。呼び出し 1 回につき 1 件、`surface: 'cli'` として記録され、引数は同じ `.agent({ redact })` のリストでマスクされます。記録は MCP の記録と同じファイルに並び、別のファイルは作られません。これには実際的な意味があります。ターミナルからの呼び出しは `--as` で指定したユーザーとして実行され、検証される資格情報が 1 つもありません。監査ログで残しておきたいのは、まさにこうした書き込みです。

`bunx guren tool:call --preflight` は、MCP 経由の予行演習とまったく同じように `guren_preflight` として記録され、確認された側のツール名は引数に残ります。ハンドラーは実行されていないので、確認した側のツール名で記録すると、最後まで実行された呼び出しと区別できなくなるからです。アプリケーションの `@guren/core` が preflight の継ぎ目に対応していない古いバージョンの場合は、呼び出しが実際に実行されます。その場合はコマンドが警告を出し、記録には実際に実行されたツールの名前が残ります。

`tool:call` で記録されるのは呼び出し(invocation)だけで、拒否(denial)は記録されません。4 つの拒否理由はどれも、アダプターがリクエストを組み立てる前に行うチェックですが、このコマンドはそのどれも行わないからです。トークンを持たず、アプリに直接ディスパッチします。アプリケーションが返した 401 や 403 はレスポンスなので、ほかの経路(surface)と同じく、そのステータスの呼び出しとして記録されます。呼び出し主体は `--as` で指定したユーザーで、指定がなければ `null` です。`abilities` は含まれません。abilities はトークンに付くものですが、ここにはトークンがないからです。

シンクを設定していないアプリケーションでは、`tool:call` の呼び出しも記録されません。呼び出し自体はこれまでどおり実行され、結果も表示されます。

**シンクの設定をあえて任意にしているのには理由があります。** このエンドポイントは、書き込めるファイルシステムがない Workers や、ファイルシステムが一時的な Lambda でも動きます。フレームワークが勝手にファイルへの追記を始めると、設定は同じに見えるのに、デプロイ先によっては記録が黙って欠けていく監査ログになってしまいます。監査ログは、記録が漏れなく残っているかが分かって初めて役に立つので、Guren では書き出し先を明示してもらう設計にしています。

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
| `--tail`・`-f` | 新しいレコードが届くたびに表示する |
| `--tool <name>` | 指定したツールだけ |
| `--surface <s>` | `mcp`・`dev-mcp`・`cli`・`webmcp`・`durable`・`in-process` のいずれかだけ |
| `--denied` | 拒否だけ |
| `--since <duration>` | `30m`・`2h`・`7d` などの期間より新しいレコードだけ |
| `-n <count>` | 表示する件数(既定は 50) |
| `--app <dir>` | ベースパスを解決するときの基準になるアプリケーションのルート |
| `--json` | 1 行 1 レコードの生データ |

`tool:log` はアプリケーションを起動しません。記録しているアプリが起動できなくなっていても、監査ログは読めなければ困るからです。日ごとに分かれたファイルを新しいものから順に読むので、日付をまたいで `-n` を指定しても正しく件数がそろいます。`-n` はフィルタをかけたあとに適用されるので、`--denied -n 50` は「直近 50 件の中の拒否」ではなく「直近の拒否 50 件」になります。

監査ログが 1 件も見つからないときは、空の一覧ではなく、追加すべき設定の行を表示します。ここで空の一覧を出すと「どのエージェントもこのアプリに触れていない」と読めてしまいますが、シンクを設定していないだけなら、それはまったく逆の結論になってしまいます。

### redaction

`event.arguments` は、イベントを作る前にマスクされます。マスクの対象は、2 つのリストを合わせたものです。1 つは、どのアプリでも設定なしで有効になる機密性の高いキー断片の組み込みリスト(`password`・`passphrase`・`secret`・`token`・`apikey`・`authorization`・`credential`・`cookie`・`session`)、もう 1 つはルート自身の `redact` メタデータです。

```ts
router
  .post('/integrations', { body: CreateIntegrationSchema }, [IntegrationController, 'store'])
  .name('integrations.store')
  .agent({
    description: 'Connect an external integration.',
    redact: ['webhookUrl'],
  })
```

一致の判定は、あえて大まかにしてあり、マスクしすぎる方向に倒れます。

- キーの名前を小文字にして区切り文字を取り除いたものに、断片が**含まれていれば**一致します。`apiKey`・`api_key`・`x-api-key` は、どれも `apikey` 1 つで対象になります
- 自分で宣言したエントリにも同じ判定が使われるので、`redact: ['id']` と書くと `userId` もマスクされます
- 値の形より先に、キーで判定します。`token` という名前のキーの下にあるネストしたオブジェクトは、中身をたどらずにまるごとマスクされます

マスクした値は `[REDACTED]` に置き換えます。値をたどる処理は必ず終わるようにしてあり、循環参照は `[Circular]`、極端に深いペイロードは `[Truncated]` になります。この処理は「何かが起きた」ことを記録している最中に動き、ルート自身の検証より前に行われた拒否も対象になるからです。

## dev MCP は別のエンドポイントです

Guren には以前から MCP エンドポイントがありますが、ここまで説明してきたエンドポイントとは別のものです。この 2 つは混同しないでください。

| | dev MCP | アプリ MCP |
|---|---|---|
| パス | `/_guren/mcp` | `/mcp`(設定可能) |
| 提供元 | フレームワーク本体 | `@guren/plugin-mcp` |
| 操作対象 | ディスク上のプロジェクト | アプリケーションのデータ |
| 想定利用者 | 開発者自身のコーディングエージェント | アプリのユーザーが使うエージェント |
| ゲート | `GUREN_MCP=1` **かつ**、接続元が loopback であることを検証できた場合。安全側に倒す(fail-closed) | bearer トークンのあとに、そのツールスコープ |
| ツール | フレームワークが用意した決まったツール(context・checks・scaffolding) | `.agent()` を付けたルート |
| 本番環境 | 存在しない。ゲートの判定は各デプロイプラグインがバンドル時に確定させる | マウントされる |

`GUREN_MCP=1` で動かしている開発サーバーを、トンネルで外部に公開しないでください。このエンドポイントはプロジェクトにファイルを書き込めます。開発側での使い方は[スペック起点の開発](./spec-anchored.md)を参照してください。

## チェックが守るもの

これらのルールは通常の `bunx guren check` の中で実行され、アプリにエージェントルートがあるときだけ有効になります。エージェントルートのないアプリでは指摘(finding)は出ず、コントローラの走査も行われません。

`check` が**失敗**(failure)として扱うのは、名前のないエージェントルート、MCP の文法に合わないツール名、フレームワークが予約しているツール名(`guren_preflight`)、同じツール名になる 2 つ以上のルート、そして読み取り専用でないツールのうち、ミドルウェアチェーンに認可の capability がなく、アクションでも `this.authorize(...)` を呼んでいないものです。

`check` が**警告**(warn)を出すのは、次の場合です。一部のクライアントに捨てられるツール名(ドットを含む、または 64 文字を超える。`agent.toolName` を使って直します。参考扱い(advisory)なので `check --ci` と `guren gate` は失敗しません)、出力の形がない、Inertia で応答している、ボディを受け取るのに `body` スキーマがない、読み取り専用のツールなのにアクションが変更を行っている、そして判定できなかった場合(インラインハンドラ、読み取れなかったコントローラファイル、同じ名前のコントローラクラスが 2 つある場合)です。

`bunx guren audit` は、同じルートをより厳しく扱います。通常のルートでは警告で済むボディ検証の指摘が、エージェントに公開したルートでは**失敗**になります。また、レコードを削除、更新、force-write するアクションに `destructiveHint: false` が付いていると警告します。

指摘のキー(finding key)の一覧は [CLI: エージェントに公開したルート](./cli.md#エージェントに公開したルート)にあります。

## 関連

- [ルーティング: エージェントツール](./routing.md#エージェントツール): ほかのルートコントラクトと `.agent()` の関係
- [API トークン](./api-tokens.md): MCP エンドポイントが bearer を検証するときに使うストア
- [認可](./authorization.md): 呼び出し主体に何を許可するかを決めるポリシー
- [イベント](./events.md): リスナーの登録方法とイベントマネージャ
- [CLI](./cli.md): `tool:list`・`tool:inspect` と、check・audit の指摘のキー
- [AI エージェント](./ai-agents.md): これらのツールを使ってモデルを呼び出す、アプリ内のエージェントクラス
- [永続エージェント](./durable-agents.md): これらのツールを呼び出す独自のエージェントをホストする

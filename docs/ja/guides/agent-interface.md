# エージェントインターフェース

AI エージェントは MCP を通じてアプリケーションを呼び出します。Guren では、エージェント向けにアプリケーションをもう 1 つ書く必要はありません。エージェントツールは、**ルートがすでに持っているコントラクトから導出**されます。ルートの `params`・`query`・`body` スキーマがツールの入力スキーマに、`output` スキーマがツールの出力スキーマに、ミドルウェアチェーンが検査するポリシーがツールの認可になります。

ツールクラスを書く必要も、2 つ目の JSON Schema を書いて同期を保つ必要もありません。スキーマは 1 つしかないので、エンドポイントが検証しない形をツールが公開してしまうこともありません。ツールが呼ばれると、フレームワークのディスパッチャーがその呼び出しを本物の HTTP リクエストに組み立て直し、アプリケーションに送り込みます。そのため、検証もミドルウェアもポリシーも、普段と同じ場所でちょうど 1 回ずつ実行されます。

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

アプリケーション側で変更するのはこれだけです。ここから先は、使う順に説明します。宣言と、そこから導出されるスキーマ、ローカルでのツールの確認と呼び出し、MCP での公開です。守りを固めるトークン、承認、監査ログは、[エージェントツールの権限と監査](./agent-tool-governance.md)で説明します。

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
| `approval` | `'required'` を付けると、呼び出しはすぐには実行されず、人の承認を待つ申請になります。[承認が必要なツール](./agent-tool-governance.md#承認が必要なツール)を参照してください。承認キューを設定していない場合、MCP エンドポイントは安全側に倒し(fail-closed)、ツールを一覧にも出さず、呼び出しも受け付けません。 |
| `redact` | 監査ログでマスクする引数のフィールド名。[監査ログ](./agent-tool-governance.md#監査ログ)を参照してください。 |

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

`createForceHttpsMiddleware()` も、ツールの呼び出しは https にリダイレクトせずに通します。ディスパッチャーが組み立てるリクエストは、呼び出し元がアクセスしたオリジンで組み立てられます。TLS を終端するプロキシの後ろにある MCP エンドポイントなら `http://`、durable agent、`guren tool:call`、`TestApp.agent()`、`APP_URL` のないプロセス内 AI エージェントなら `http://localhost` です。このリクエストはプロセスの外に出ないので、https に切り替えるべき通信路がそもそもありません。上の認証ガードとは違い、このミドルウェアはヘッダーを見ません。通すのはディスパッチャーが組み立てたリクエストオブジェクトだけなので、同じヘッダーを付けた外部からの HTTP リクエストはリダイレクトされます。

`this.inertia(...)` で応答するアクションは、ページがコンポーネントに渡している内容をそのまま返します。この形は何にも検査されず、UI を変えただけで簡単に変わってしまいます。エージェント向けのルートでは `output` と `this.json(...)` を使ってください。Inertia で応答している場合は `guren check` が警告を出します。

## アノテーション

MCP のアノテーションは、ツールの性質をクライアントに伝えるためのものです。Guren は 3 つのアノテーションすべてを明示的な値に決めてから渡すので、受け取る側で既定値を補い直す必要はありません。

| アノテーション | 既定値 |
|---|---|
| `readOnlyHint` | GET と QUERY は true、それ以外は false |
| `destructiveHint` | `readOnlyHint` の逆。読み取り専用でないツールに対する MCP 仕様の既定値は `true` です |
| `idempotentHint` | GET・QUERY・PUT・DELETE は true |

**アノテーションはクライアントの UX のためのヒントで、何も強制しません。** 実際の強制は、ポリシー(ブラウザからのリクエストとまったく同じく、ディスパッチされたリクエストの中で評価されます)と、[トークンのスコープ](./agent-tool-governance.md#トークンとスコープ)(リクエストを組み立てる前に評価されます)が担います。そのため、検査を*ゆるめる*方向の 2 つの宣言については、コントローラの本体と突き合わせて確かめます。

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

違うのは、呼び出し元が誰なのかを示す方法だけです。MCP クライアントは bearer トークンを提示します。このトークンはリクエストを組み立てる前にスコープを検査され、cookie を持たないので CSRF 検証もスキップされます。一方の `tool:call` は `--as` で認証し、ブラウザと同じ手順で CSRF トークンを取得します。そのため `tool:call` が成功して分かるのは、そのツールが動くことだけです。特定のトークンがそのツールに届くスコープを持っているかどうかは分からず、それは [`guren token:issue`](./agent-tool-governance.md#トークンを発行する) でトークンを発行するときに決まります。

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

Preflight only: the request passed this route's middleware and its body schema.
The handler did not run. The route's own middleware did run, so any effect a
middleware on this route has of its own has already happened. No authorization
middleware was found on this route, so any check inside the handler itself was
not evaluated.
```

リクエストはルートのミドルウェアを通り、ツールが公開しているコントラクトで検証されてから、ハンドラーの手前で止まります。`unverified` に並ぶのは、本当の呼び出しであればこの先でまだ評価されるものです。たとえばアクションの中で行う認可には、ハンドラーの手前で止まる予行演習ではたどり着けません。

**予行演習は、リクエスト全体のドライランとは違います。** 予行演習は、ほかのすべてのミドルウェアの後ろに置いた地点で止まります。手前のゲートがすべて本物であるからこそ判定(verdict)に意味があるのですが、その代わり、ルートのミドルウェアは実際に動いています。クォータを加算する、レート制限の枠を消費する、セッションに触れる、外部を呼ぶといったミドルウェアの副作用は、すでに起きています。スキップされるのはハンドラーだけです。

MCP からは、フラグではなく専用のツールを使って同じ予行演習を行います([MCP 経由で呼び出しを予行演習する](#mcp-経由で呼び出しを予行演習する))。`outputSchema` を公開するツールは、それに合った `structuredContent` を返さなければなりません。判定はどのルートの出力の形にも合わないので、判定を返すための専用ツールが必要になります。`tool:call` と `@guren/testing` はこの制約を受けないので、呼び出しそのものに対して判定を求められます。

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

有効なトークンを持っているだけでは、ツールは見えません。トークンには `tool:` か `tools:` のスコープも必要です。`ApiToken` の既定値の `['*']` はどのツールも許可しないので、スコープなしで発行したトークンでは `tools/list` が空になります。トークンは [`guren token:issue --tools`](./agent-tool-governance.md#トークンを発行する) で発行してください。

このエンドポイントのために CSRF の除外設定を書く必要はありません。`Authorization: Bearer` を持ち、`Cookie` ヘッダーをまったく持たないリクエストは、フレームワーク全体で CSRF 検証がスキップされます。cookie による暗黙の権限(ambient authority)がないので、守る対象がないからです。ディスパッチャが組み立てる bearer リクエストも、仕組み上 cookie を持ちません。

プラグインは、自分が設定されたパスを「cookie なしで認証するパス」としても宣言します。そのため、上の規則に当てはまらないリクエスト（bearer を持たないもの、ブラウザーが cookie を付けたもの）には、本当の理由を隠してしまう CSRF の `403` ではなく、上の `401` が返ります。どちらのスキップも、何かを認証するわけではありません。入り口は bearer トークンと、プロセス内の呼び出し元（永続エージェントなど）が設定する身元の 2 つだけで、ブラウザーはどちらも提示できません。

`bunx guren audit` は、この宣言をほかのパッケージの宣言と一緒に **Plugin CSRF exemptions** の見出しの下に報告します。`node_modules` の中で行われた除外を audit が見られるのは、ここだけです。報告はパスではなくパッケージ単位です。パスは、それぞれのパッケージの設定から起動時に計算される引数だからです。`@guren/` スコープ外のパッケージによる宣言は警告になります。このリポジトリが保証できるのは自分のパッケージだけだからです。audit が読むのは `package.json` に宣言したパッケージなので、別の依存を通してしか入っていないプラグインは対象外です。

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
| `approvals` | なし | 承認キュー。`{ store, notify, ttlMs? }` を渡します。[承認が必要なツール](./agent-tool-governance.md#承認が必要なツール)を参照 |
| `audit` | なし | 監査ログの出力先。`{ file, days? }` か `{ sink }` を渡します。[監査ログを書き出す](./agent-tool-governance.md#監査ログを書き出す)を参照 |

レート制限のキーは IP ではなく**トークン ID** なので、上限は資格情報ごとにかかります。制限はプロセスのメモリ上で数えるため、常駐サーバーが 1 台なら正確に効きますが、複数のインスタンスやサーバーレスではインスタンスごとの制限になります。全体で 1 つの上限を設けたい場合は、共有のストアとアプリ自身の[レート制限ミドルウェア](./rate-limiting.md)が必要です。

> エージェントルートにアプリ自身のレート制限ミドルウェアを置いても、この制限の代わりにはなりません。そのミドルウェアの既定のキーはソケットの接続元から作られますが、ディスパッチャーが組み立てるリクエストはソケットを通っていないので、MCP の呼び出し元がすべて、そのルートの共有バケット 1 つにまとめられてしまいます。

### MCP 経由で呼び出しを予行演習する

エンドポイントには、エンドポイント自身が提供するツールとして `guren_preflight` が加わります。このツールは、ほかのツールへの呼び出しが許可されるかどうかを答えるだけで、その呼び出し自体は実行しません。

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

止まる地点は、`--preflight` と同じです。確認対象のツール自身のミドルウェアが動き、公開しているコントラクトで検証されたあと、ハンドラーの手前でリクエストが止まります。アクション自体は実行されませんが、ミドルウェアは実際に動くので、ミドルウェアの副作用は起きます。

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

`validated` と `unverified` が含まれるのは、リクエストがその地点までたどり着いたときだけです。それより手前で認証や認可のミドルウェアに拒否された場合は、たどり着かなかったチェックについて何も言えないので、空の配列にするのではなく、フィールドごと省きます。

覚えておきたい規則が 4 つあります。

- **ツールを確認するには、そのツールを呼ぶのと同じスコープが必要です。** そうしないと、呼べないツールの認可の仕組みを探る手段になってしまいます。付与されていない名前を指定すると、直接呼んだときと同じように error の結果で拒否されます。
- **承認が必要なツールも確認できます。** 本当に呼ぶと人への申請が作られるので、申請を作らずに「受け付けられるか」を確かめるには予行演習を使います。予行演習では何も実行されません。
- **`guren_preflight` が一覧に出るのは、ツールを 1 つ以上付与されたトークンだけです。** 何も呼べないトークンには、予行演習する対象がないからです。
- **この名前は予約されています。** `.agent()` のツール名にこの名前を使ったルートは `bunx guren check` で失敗になり、エンドポイントもそのルートを公開しません。同じ名前のツールが 2 つあると、MCP クライアントはツールのカタログ全体を受け付けなくなります。

予行演習は申請とは別のものです。承認が必要なツールを予行演習しても、申請は作られず、承認者に通知も届きません。

## ツールへのアクセスを絞る

[エージェントツールの権限と監査](./agent-tool-governance.md)では、MCP から呼び出すときに必ず必要になるトークンのスコープと、任意で使える 2 つの仕組み（人の確認を挟む承認ゲートと、監査ログ）を説明しています。

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

指摘のキー(finding key)の一覧は [チェックと監査の詳細: エージェントに公開したルート](./cli-checks.md#エージェントに公開したルート)にあります。

## 関連

- [ルーティング: エージェントツール](./routing.md#エージェントツール): ほかのルートコントラクトと `.agent()` の関係
- [エージェントツールの権限と監査](./agent-tool-governance.md): トークンのスコープ、承認ゲート、監査ログ
- [API トークン](./api-tokens.md): MCP エンドポイントが bearer を検証するときに使うストア
- [認可](./authorization.md): 呼び出し主体に何を許可するかを決めるポリシー
- [CLI](./cli.md): `tool:list` と `tool:inspect`
- [チェックと監査の詳細](./cli-checks.md#エージェントに公開したルート): エージェント向けルートについての check・audit の指摘のキー
- [AI エージェント](./ai-agents.md): これらのツールを使ってモデルを呼び出す、アプリ内のエージェントクラス
- [永続エージェント](./durable-agents.md): これらのツールを呼び出す独自のエージェントをホストする

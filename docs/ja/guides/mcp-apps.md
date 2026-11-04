# MCP Apps

MCP App を使うと、ツールの結果をエージェントのホストの中でページとして表示できます。Guren では、そのページにルートがすでに描画している Inertia のページをそのまま使います。ルートの `.agent()` の宣言に `ui` を足して view をビルドすれば、Claude の Web 版のような MCP Apps 対応のホストは、投稿をテキストで返す代わりに `posts/Show` を表示します。view の中のリンクやフォームもそのまま動き、Inertia の遷移はそれぞれ対応するツールの呼び出しになります。

前提として、ルートが [Agent Interface](./agent-interface.md) のエージェントツールになっていて、`mcpPlugin()` で公開されている必要があります。

## view を宣言する

`ui` にページを渡します。普段は生成されたページの契約を渡しますが、ページ ID の文字列でもかまいません。

```ts
import { Router } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { PostController } from '@/app/Http/Controllers/PostController'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index']).name('posts.index')
    .agent({ description: 'List the latest posts.', ui: pages.posts.Index })
  router.get('/posts/:id', [PostController, 'show']).name('posts.show')
    .agent({ description: 'Show one post.', ui: pages.posts.Show })
}
```

ページには、コントローラーが `this.inertia()` に渡す props がそのまま届くので、コントローラーは変えなくて済みます。

view からだけ呼ぶツールも作れます。たとえばリダイレクトで終わる `update` ルートは自分のページを持ちませんが、`posts/Show` の中の編集フォームはこのルートに送信します。こうしたツールは、ページを指定せずに `visibility` だけで宣言します。

```ts
router.put('/posts/:id', [PostController, 'update']).name('posts.update')
  .agent({ description: 'Update a post.', ui: { visibility: ['app'] } })
```

`visibility` の既定値は `['model', 'app']` です。`['app']` にするとモデルのツール一覧には出なくなり、view からしか呼べなくなります。

宣言の内容は、`bunx guren tool:list` の `UI` 列と、`bunx guren tool:inspect posts.show` の `UI:` 行で確かめられます。

```text
UI:            page posts/Show; visible to model, app
```

## view をビルドする

ホストは view を 1 つの自己完結した HTML 文書として読み込み、外から何も取得しません。そのため view は通常のビルドとは別にビルドします。最初に一度だけ、MCP Apps のクライアントを入れておきます。

```bash
bun add @modelcontextprotocol/ext-apps
```

そのうえでビルドします。

```bash
bunx guren codegen
bunx vite build --mode mcp-app
```

ビルドすると、`ui` ルートが指定したページごとに文書が 1 つずつ作られ、プラグインがそれを配信するためのモジュール `.guren/mcp-app/index.gen.ts` も書き出されます。scaffold したアプリの `build` スクリプトは最後にこのステップを実行します。`ui` ルートが 1 つもなければ、このステップでは何も作られません。

最初のビルドでは `resources/js/mcp-app.tsx` も書き出されます。どの view もこのファイルの設定でマウントされ、中身はアプリのスタイルシートの読み込みと、ページを包むエラーバウンダリです。以降はアプリのファイルとして扱い、プロバイダーは `resources/js/app.tsx` とそろえておいてください。

## view を配信する

`mcpPlugin()` に、ビルドしたモジュールを指定します。

```ts
import { mcpPlugin } from '@guren/plugin-mcp'

mcpPlugin({
  serverInfo: { name: 'blog', version: '1.0.0' },
  ui: {
    pages: () => import('@/.guren/mcp-app/index.gen'),
    presentation: { 'posts/Show': { prefersBorder: true } },
    sharedProps: ['_i18n'],
  },
})
```

| オプション | 役割 |
|---|---|
| `pages` | ビルドしたモジュール。import で読み込むので、どのデプロイ先のバンドラーでも view がバンドルに含まれます。 |
| `presentation` | ページごとの表示の指定です。`prefersBorder` を付けると、ホストに view の枠線を描くよう求めます。 |
| `sharedProps` | ツール呼び出しに載せる Inertia の共有 props です。既定では空で、ツール呼び出しでは `share()` のリゾルバーは動きません。翻訳など、レイアウトが使うものだけを指定します。 |
| `csp` | view が読み込みや接続をしてよいオリジン（`resourceDomains`、`connectDomains`、`frameDomains`、`baseUriDomains`）です。 |

これで `tools/list` に各 view の `ui://` アドレスが載ります。アドレスにはビルドの内容のハッシュが入り、文書そのものは `resources/read` で配信されます。ビルドされていないページを指定したツールは view なしで一覧に出て、起動時に一度だけ警告が表示されます。

view の CSP は既定では空で、ネットワークにはつながらず、外部の画像やフォント、スクリプトも読み込めません。ビルドで文書に埋め込まれたものはすべて動きます。アップロードされたカバー画像のようにアプリ自身が配信する画像は、そのオリジンを `resourceDomains` に足すまで表示されません。オリジンを 1 つ足すごとに、すべての view が届く範囲もそれだけ広がります。

## view の中の動き

view はツールの結果に含まれる props でページを描画し、その後の Inertia の遷移を自分で処理します。

- メソッドとパスがツールに一致する遷移は、ホストを通じてそのツールを呼び、返ってきたページで今のページを置き換えます。バリデーションエラーは、ブラウザと同じようにフォームの `errors` に入ります。
- リダイレクトは、一致するツールを通じて最大 5 回までたどります。
- この view に入っていないページや、ツールになっていないルートへの遷移は、代わりにブラウザで開きます。文書 1 つにはページが 1 つしか入らないので、`posts/Index` から `posts/Show` へのリンクは view の外に出ます。
- [承認](./agent-tool-governance.md)が必要なツールでは、ページはそのままで、承認待ちのリクエストが報告されます。

ページやレイアウトがどこで動いているかは、`@guren/inertia-client/mcp-app` の `useMcpApp()` で分かります。

```tsx
import { useMcpApp } from '@guren/inertia-client/mcp-app'

export default function Layout({ children }: { children: React.ReactNode }) {
  const app = useMcpApp()
  return (
    <>
      {app.isMcpApp ? null : <Navigation />}
      {app.refusal ? <p>{app.refusal.message}</p> : null}
      {children}
    </>
  )
}
```

| フィールド | 意味 |
|---|---|
| `isMcpApp` | ホストの中で動いているかどうか。ブラウザでは false です。 |
| `interactive` | 遷移をツール呼び出しにできるかどうか。ホストがツール呼び出しを提供していないときや、サーバーの view のプロトコルの版が違うときは false です。 |
| `pendingApproval` | 承認者の判断を待っている遷移のリクエストです。 |
| `refusal` | view が最後に実行できなかった遷移です。アプリでそのページを開くための `url` が付きます。 |
| `hostContext` | ホストが伝えてくる自身の情報で、テーマ、表示モード、コンテナの大きさなどです。 |
| `sendMessage()`、`updateModelContext()`、`openLink()` | ホストにメッセージの投稿、モデルへのコンテキストの追加、リンクを開くことを頼みます。 |

ツール呼び出しは Inertia のリクエストではないので、view の中では[遅延 props](./inertia.md) が解決されません。`ui` のページが使う props は、最初のレスポンスに含めておいてください。

## Dev Center でプレビューする

`GUREN_MCP=1` を付けて開発サーバーを動かし（scaffold した `dev` スクリプトは付けています）、`http://localhost:3333/_guren/mcp-apps` を開きます。このプレビューはそれ自体が 1 つのホストです。アプリの App MCP エンドポイントからツールを呼び、Web 版のホストと同じように、別のオリジンに置いた sandbox を通して view の CSP の下で描画します。

1. ツールを実行するユーザーのトークンを発行します。

   ```bash
   bunx guren token:issue --name dev-center --user 1 --tools tools:read --expires 12h
   ```

2. トークンを貼り付けて **List tools** を押すと、そのトークンで見える view 付きのツールが一覧になります。トークンはページのメモリにだけ置かれ、同じオリジンのエンドポイントにだけ送られます。
3. ツールの引数を JSON で入力し、**Call and render** を押します。

view の横の **Messages** には、ツールの入力と結果、遷移ごとのツール呼び出し、大きさの変更など、ホストと view のやり取りがすべて並びます。view が開こうとしたリンクや会話に送ろうとしたメッセージもここに並ぶだけで、実際に開いたり送ったりはしません。

sandbox は、`localhost` で開いた Dev Center に対して `127.0.0.1` で配信されるので、両者のオリジンが同じになることはありません。それ以外のホスト名で開くと、`localhost` で開き直すよう案内が出ます。

## 実際のホストで試す

外部のホストは HTTPS でエンドポイントに接続するので、手元のアプリの前にはトンネルが要ります。初めて試すときにつまずきやすい点が 2 つあります。

- ホストは、コネクタが対応している方法でしか認証できません。OAuth か認証なししか選べないコネクタでは、エンドポイントが求める bearer トークンを送れません。選べる方法は[ツールを公開する](./agent-interface.md#ツールを公開する)を参照してください。
- ホストによっては、接続している間ツールの一覧をキャッシュします。ビルドし直したら接続し直して、新しい `ui://` アドレスを読ませてください。

## チェックが守るもの

`bunx guren check` は、すべての `ui` の宣言を確かめます。

| チェック | 失敗または警告になる条件 |
|---|---|
| `agent-route-ui-page` | `.guren/pages.gen.ts` にないページを `ui` が指定している。 |
| `agent-route-ui-shape` | `ui` の形が正しくない（空のページ ID、未知の値や空の `visibility`）。そのツールは一覧から外され、モデルにも見えません。 |
| `agent-route-ui-output` | ルートがページと `output` スキーマの両方を宣言している。1 つのレスポンスを両方で表すことはできません。 |
| `agent-route-ui-renders` | アクションが指定のページを描画しないので、view にページが届かない（警告）。 |
| `agent-route-ui-deferred` | アクションが遅延 props を渡しているが、view ではそれが解決されない（警告）。 |
| `agent-route-ui-visibility` | MCP で公開していないルートに `visibility: ['app']` が付いていて、どのホストからも呼べない（警告）。 |
| `agent-route-ui-pages-module` | ルートがページを宣言しているのに、`mcpPlugin()` に `ui` オプションがない（警告）。 |

## 関連

- [Agent Interface](./agent-interface.md): ツールの宣言と MCP での公開
- [エージェントツールの権限と監査](./agent-tool-governance.md): view が行う呼び出しのスコープ、承認、監査
- [API トークン](./api-tokens.md): ホストが使うトークンの発行と失効
- [Inertia](./inertia.md): ページ、props、遷移

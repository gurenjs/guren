# Inertia プロトコル対応

Guren は `@guren/core` に自前の Inertia サーバーアダプタを持ち、`@inertiajs/react` 3 が話す [Inertia プロトコル](https://inertiajs.com/the-protocol)に沿って実装しています。このページは対応表です。プロトコルのどの部分を実装し、どの部分を実装していないか、それぞれの説明がどのガイドにあるかをまとめます。Laravel、Rails、AdonisJS のアダプタから来た場合は、このページを先に、[フロントエンドガイド](./frontend.md)を次に読んでください。

## Guren での Inertia アプリの形

コントローラーはページを名前で指定し、props を渡します。ページ名は codegen が生成するので、コンポーネントパスの打ち間違いや props の不足は実行時ではなくコンパイル時に分かります。

```typescript
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export class UserController extends Controller {
  async index() {
    return this.inertia(pages.users.Index, {
      users: () => User.all(),
    })
  }
}
```

ページコンポーネントは `resources/js/pages/users/Index.tsx` にあり、`Props` を宣言します。`bunx guren codegen` がそのインターフェースを取り出し、コントローラーの呼び出しを検査します。プロジェクト構成、フォーム、型の流れは[フロントエンドガイド](./frontend.md)を参照してください。

## プロトコル対応表

| プロトコルの機能 | 状態 | Guren では |
|---|---|---|
| ページオブジェクトを埋め込んだ HTML ドキュメント | 対応 | ページオブジェクトは `<` をエスケープして直列化するので、props のデータが `<script>` 要素を閉じることはありません。 |
| Inertia JSON レスポンス（`X-Inertia`、`Vary`） | 対応 | `Vary` には `Accept`、`X-Inertia` と partial reload の3ヘッダを列挙します。 |
| アセットのバージョン管理（`version`、GET の不一致で `X-Inertia-Location` 付き 409） | 対応 | バージョンは `version` オプションか `GUREN_INERTIA_VERSION` から取ります。後者はアセットのブートストラップが Vite の manifest から設定します。409 の判定は props の解決より前に行うので、古いクライアントが lazy なクエリを走らせることはありません。`X-Inertia-Version` は返しません。 |
| Partial reloads（`X-Inertia-Partial-Component`、`-Data`、`-Except`） | 対応 | トップレベルのキーだけを見ます。ヘッダの `author.name` は `author` を選びます。[Partial Reloads](./frontend.md#partial-reloads) を参照してください。 |
| Lazy props（送るときだけ評価する関数） | 対応 | `() => value` を渡します。ページの `Props` は解決後の型を宣言したままです。 |
| Always props | 対応 | `always(value)`。`errors` はこの形で共有しています。 |
| グループ付き deferred props（`deferredProps`） | 対応 | `defer(() => value, group)`。[Deferred Props](./frontend.md#deferred-props) を参照してください。 |
| Rescued deferred props（`rescuedProps`） | 未対応 | deferred のコールバックが throw すると、後続リクエストが失敗します。 |
| Optional props | 未対応 | 初回描画の後で届いてよいデータには `defer()` を使ってください。 |
| Merge、prepend、deep merge props（`mergeProps`、`prependProps`、`deepMergeProps`、`matchPropsOn`） | 未対応 | partial reload は prop を置き換えます。 |
| Once props（`onceProps`、`X-Inertia-Except-Once-Props`） | 未対応 | |
| Infinite scroll（`scrollProps`） | 未対応 | merge props の上に成り立つ機能です。 |
| Props のリセット（`X-Inertia-Reset`） | 未対応 | merge しないので、リセットする対象がありません。 |
| History の暗号化（`encryptHistory`、`clearHistory`） | 未対応 | |
| `errors` prop でのバリデーションエラー | 対応 | Inertia リクエストで `ValidationException` が起きると、エラーを flash して 303 で元のページへ戻します。次の描画はフィールドごとに1件のメッセージを持ちます。セッションが無いアプリでは cookie で同じ動きをします。[フォームのバリデーションエラー](./validation.md)を参照してください。 |
| Error bags（`X-Inertia-Error-Bag`） | 未対応 | エラーはページごとに1つのオブジェクトです。 |
| リダイレクト（GET 以外のリクエストの後は 303） | 対応 | `this.redirect()` は GET 以外のリクエストに 303 を返します。 |
| 外部リダイレクト（`X-Inertia-Location` 付き 409） | ヘルパー無し | status 409 とこのヘッダを持つ `Response` を自分で返してください。 |
| フラグメント付きリダイレクト（`X-Inertia-Redirect`、`preserveFragment`） | 未対応 | |
| 共有データ | 対応 | `shareInertiaProps()` はリクエストごとに解決し、partial reload のフィルタを通ります。ページオブジェクトの `sharedProps` は出しません。 |
| ページオブジェクトの flash データ（`flash`） | 未対応 | flash の値は `always()` prop として共有してください。 |
| CSRF（`XSRF-TOKEN` cookie、`X-XSRF-TOKEN` ヘッダ） | 対応 | [CSRF ガイド](./csrf.md)の Inertia.js の節を参照してください。 |
| サーバーサイドレンダリング | 対応（同一プロセス） | `renderInertiaServer()` は別の Node サーバーではなくアプリの中で動くので、`/render`、`/health`、`/shutdown` の契約は当てはまりません。描画に失敗するとログを出してクライアント描画に切り替えます。[フロントエンドガイド](./frontend.md)の SSR の節を参照してください。 |
| Prefetch（`Purpose: prefetch`） | サーバー側の対応は不要 | クライアント側の機能はそのまま動きます。 |
| Precognition | 未対応 | |

`<WhenVisible>`、`usePrefetch`、`<Form>` コンポーネントのようにサーバー側の対応を必要としない機能は、`@inertiajs/react` のドキュメント通りに動きます。

## テスト

`TestApp` はページオブジェクトを直接検証します。

```typescript
await app.get('/users').assertInertia('users/Index', { users: [] })
```

`@guren/testing` のコントローラーモックは、lazy、always、deferred の各 props をランタイムと同じ規則で解決します。コントローラーのテストが見る props は、ブラウザが受け取るものと同じです。[テストガイド](./testing.md)を参照してください。

## プロトコルの外側

他のアダプタから来た読者がそこには見つけないものです。

- ページ ID と `Props` は生成物なので、`this.inertia()` はコンポーネントが宣言した props に対して検査されます。`ControllerInertiaProps` は解決後の型をページ側へ返します。
- `@guren/inertia-client` の `createTypedLink()` と `createTypedForm()` は、ルート名とパラメータをコンパイル時に検査します。
- `bunx guren check` は、ページが必須と宣言した prop にコントローラーが `defer()` を渡すと警告します。
- プロトタイプモードでは、コントローラーが無くても fixture からページを配信します。[プロトタイプファースト](./prototype-first.md)を参照してください。

## クライアントフレームワーク

scaffold と `@guren/inertia-client` は React 向けです。サーバーアダプタはどの Inertia クライアントがリクエストを送るかに依存しませんが、Vue や Svelte 向けの scaffold、SSR エントリ、型付きコンポーネントは同梱していません。

## 次のステップ

- [フロントエンド](./frontend.md): ページコンポーネント、フォーム、partial reloads、deferred props、SSR。
- [バリデーション](./validation.md): バリデーションエラーが Inertia のフォームへ届く仕組み。
- [テスト](./testing.md): `assertInertia()` とコントローラーモック。

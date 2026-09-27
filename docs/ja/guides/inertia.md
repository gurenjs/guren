# Inertia プロトコル対応

Guren は Inertia のサーバーアダプタを `@guren/core` に自前で持っており、`@inertiajs/react` 3 が使う [Inertia プロトコル](https://inertiajs.com/the-protocol)に沿って実装しています。このページはその対応表で、プロトコルのどの部分を実装していてどの部分を実装していないか、それぞれの説明がどのガイドにあるかをまとめています。Laravel、Rails、AdonisJS のアダプタを使っていた方は、まずこのページを読み、次に[フロントエンドガイド](./frontend.md)を読んでください。

## Guren での Inertia アプリの形

コントローラーは描画するページを名前で指定し、props を渡します。ページ名は codegen が生成するので、コンポーネントパスの打ち間違いや props の渡し忘れは、実行する前にコンパイルの段階で分かります。

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

ページコンポーネントは `resources/js/pages/users/Index.tsx` に置き、`Props` を宣言します。`bunx guren codegen` を実行するとこのインターフェースが取り出され、コントローラーの呼び出しがその型で検査されます。プロジェクト構成、フォーム、型の流れは[フロントエンドガイド](./frontend.md)を参照してください。

## プロトコル対応表

| プロトコルの機能 | 状態 | Guren では |
|---|---|---|
| ページオブジェクトを埋め込んだ HTML ドキュメント | 対応 | ページオブジェクトは `<` をエスケープして直列化するので、props のデータで `<script>` 要素が閉じてしまうことはありません。 |
| Inertia JSON レスポンス（`X-Inertia`、`Vary`） | 対応 | `Vary` には `Accept`、`X-Inertia` と partial reload の3ヘッダを列挙します。 |
| アセットのバージョン管理（`version`、GET の不一致で `X-Inertia-Location` 付き 409） | 対応 | バージョンは `version` オプションか `GUREN_INERTIA_VERSION` から取ります。`GUREN_INERTIA_VERSION` は、アセットのブートストラップ処理が Vite の manifest をもとに設定します。409 を返すかどうかは props を解決する前に判定するので、古いクライアントのリクエストで lazy なクエリが走ることはありません。レスポンスに `X-Inertia-Version` は付けません。 |
| Partial reloads（`X-Inertia-Partial-Component`、`-Data`、`-Except`） | 対応 | 判定に使うのはトップレベルのキーだけで、ヘッダに `author.name` と書くと `author` が選ばれます。[Partial Reloads](./frontend.md#partial-reloads) を参照してください。 |
| Lazy props（送るときだけ評価する関数） | 対応 | `() => value` を渡します。ページの `Props` には、解決後の値の型をそのまま宣言します。 |
| Always props | 対応 | `always(value)` を使います。`errors` もこの方法で共有しています。 |
| グループ付き deferred props（`deferredProps`） | 対応 | `defer(() => value, group)`。[Deferred Props](./frontend.md#deferred-props) を参照してください。 |
| Rescued deferred props（`rescuedProps`） | 未対応 | deferred のコールバックが例外を投げると、後続のリクエストが失敗します。 |
| Optional props | 未対応 | 初回描画の後で届いてよいデータには `defer()` を使ってください。 |
| Merge、prepend、deep merge props（`mergeProps`、`prependProps`、`deepMergeProps`、`matchPropsOn`） | 未対応 | partial reload では prop が丸ごと置き換わります。 |
| Once props（`onceProps`、`X-Inertia-Except-Once-Props`） | 未対応 | |
| Infinite scroll（`scrollProps`） | 未対応 | merge props を前提にした機能です。 |
| Props のリセット（`X-Inertia-Reset`） | 未対応 | merge しないので、リセットする対象がありません。 |
| History の暗号化（`encryptHistory`、`clearHistory`） | 未対応 | |
| `errors` prop でのバリデーションエラー | 対応 | Inertia リクエストで `ValidationException` が起きると、エラーを flash して 303 で元のページへ戻します。次の描画では、フィールドごとに 1 件ずつメッセージが入ります。セッションを使わないアプリでも、cookie を使って同じように動きます。[フォームのバリデーションエラー](./validation.md)を参照してください。 |
| Error bags（`X-Inertia-Error-Bag`） | 未対応 | エラーはページごとに 1 つのフラットなオブジェクトにまとまります。 |
| リダイレクト（GET 以外のリクエストの後は 303） | 対応 | `this.redirect()` は GET 以外のリクエストに 303 を返します。 |
| 外部リダイレクト（`X-Inertia-Location` 付き 409） | ヘルパー無し | status 409 とこのヘッダを付けた `Response` を組み立てて返してください。 |
| フラグメント付きリダイレクト（`X-Inertia-Redirect`、`preserveFragment`） | 未対応 | |
| 共有データ | 対応 | `shareInertiaProps()` の値はリクエストごとに解決され、partial reload のフィルタも通ります。ページオブジェクトに `sharedProps` キーは含めません。 |
| ページオブジェクトの flash データ（`flash`） | 未対応 | flash の値は `always()` prop として共有してください。 |
| CSRF（`XSRF-TOKEN` cookie、`X-XSRF-TOKEN` ヘッダ） | 対応 | [CSRF ガイド](./csrf.md)の Inertia.js の節を参照してください。 |
| サーバーサイドレンダリング | 対応（同一プロセス） | `renderInertiaServer()` はアプリと同じプロセスの中で動き、別の Node サーバーを立てないので、`/render`、`/health`、`/shutdown` の取り決めは関係ありません。描画に失敗した場合はログを出し、クライアント側の描画に切り替えます。[フロントエンドガイド](./frontend.md)の SSR の節を参照してください。 |
| Prefetch（`Purpose: prefetch`） | サーバー側の対応は不要 | クライアント側の機能がそのまま使えます。 |
| Precognition | 未対応 | |

`<WhenVisible>`、`usePrefetch`、`<Form>` コンポーネントのようにサーバー側の対応を必要としない機能は、`@inertiajs/react` のドキュメント通りに動きます。

## テスト

`TestApp` を使うと、ページオブジェクトを直接検証できます。

```typescript
await app.get('/users').assertInertia('users/Index', { users: [] })
```

`@guren/testing` のコントローラーモックは、lazy、always、deferred の各 props をランタイムと同じ規則で解決するので、コントローラーのテストではブラウザが受け取るのと同じ props を確認できます。[テストガイド](./testing.md)を参照してください。

## プロトコルの外側

ここに挙げるのは、ほかのアダプタには無い Guren 独自の機能です。

- ページ ID と `Props` は生成されるので、`this.inertia()` の呼び出しはコンポーネントが宣言した props と照らし合わせて検査されます。ページ側では、`ControllerInertiaProps` で解決後の型を受け取れます。
- `@guren/inertia-client` の `createTypedLink()` と `createTypedForm()` は、ルート名とパラメータをコンパイル時に検査します。
- ページが必須と宣言した prop にコントローラーが `defer()` を渡していると、`bunx guren check` が警告を出します。
- プロトタイプモードでは、コントローラーを書く前から fixture のデータでページを表示できます。[プロトタイプファースト](./prototype-first.md)を参照してください。

## クライアントフレームワーク

雛形と `@guren/inertia-client` は React を対象にしています。サーバーアダプタ自体はリクエストを送る Inertia クライアントの種類を問いませんが、Vue や Svelte 向けの雛形、SSR エントリ、型付きコンポーネントは用意していません。

## 次のステップ

- [フロントエンド](./frontend.md): ページコンポーネント、フォーム、partial reloads、deferred props、SSR。
- [バリデーション](./validation.md): バリデーションエラーが Inertia のフォームへ届く仕組み。
- [テスト](./testing.md): `assertInertia()` とコントローラーモック。

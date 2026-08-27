# サーバーレンダリングビュー

`this.view()` は JSX コンポーネントをプレーンなサーバーレンダリング HTML レスポンスとして返します。ブログ記事、ドキュメント、マーケティングページのような公開・読み取り中心のページ向けの、`this.inertia()` のハイドレーションしない対になる存在です。クライアントフレームワークなし、ハイドレーションなし、Inertia のページペイロードスクリプトもドキュメントに含まれません。guren.dev 自身のブログ記事がこの仕組みで配信されています。

```ts
// app/Http/Controllers/BlogController.ts。プレーンな .ts のままで、JSX 構文はゼロ
import { Controller } from '@guren/core'
import { z } from 'zod'
import { ShowPage, PostNotFoundPage } from '../../View/ShowPage.js'
import { Post } from '../../Models/Post.js'

const SlugParamSchema = z.object({ slug: z.string().min(1) })

export default class BlogController extends Controller {
  async show() {
    const { slug } = this.validateParams(SlugParamSchema)
    const post = await Post.where({ slug }).first()

    if (!post) {
      return this.view(PostNotFoundPage, {}, { status: 404 })
    }

    return this.view(ShowPage, { post })
  }
}
```

`view(component, props, options?)` は JSX 要素ではなく、コンポーネントと props を受け取ります。そのためコントローラーはプレーンな `.ts` ファイルのままです。props は呼び出し箇所でコンパイルチェックされます。間違った prop 名は即座に型エラーになり、間に codegen のステップはありません。省略可能な第 3 引数は `status` と `headers`、そして `doctype` フラグ（[後述](#完全なドキュメントとフラグメント)）を受け付けます。

## `view()` と `this.inertia()` の使い分け

インタラクティブで状態を持つ UI、つまりフォームやダッシュボード、クライアントサイドで遷移する画面には `this.inertia()` が適しています。しかし初回のドキュメントリクエストで Inertia はページ props 全体を JSON スクリプトとして `<head>` に埋め込み、さらにサーバーサイドレンダリングが有効なら同じ内容が HTML としても `<body>` にレンダリングされます。記事本文のような大きな prop は 2 回配信されることになります。

実際のブログの公開ページを Inertia から移行した際の実測では、同じ記事が Inertia SSR ドキュメントとして 443 KB、プレーンなサーバーレンダリング HTML として 144 KB でした。guren.dev では、この重複ペイロードは圧縮後もよく生き残り、docs ページの gzip 後レスポンスの 33.7% を占めていました。

| `this.inertia()` を使う | `this.view()` を使う |
|---|---|
| インタラクティブな UI: フォーム、ダッシュボード、管理画面 | 公開・読み取り中心のコンテンツ: ブログ記事、ドキュメント、マーケティングページ |
| ページ間のクライアントサイドナビゲーション | 新規ナビゲーションとクローラー向けの SEO が重要なページ |
| React に状態を持つ画面 | フレームワークに値するハイドレーションを何もしないページ |

両者は 1 つのアプリで共存します。guren.dev のブログは記事ページを `view()` で配信しつつ、管理画面のエディタは Inertia のままです。

## 最初の View コンポーネント

View コンポーネントは `app/View/*.tsx`（モジュールローカルなら `modules/<name>/app/View/`）に置きます。`resources/js/pages/` 配下には決して置かないでください。あのディレクトリは codegen が Inertia ページ用として占有しています。すべての View ファイルは `@guren/core` を指す JSX プラグマで始まり、型も `@guren/core` からインポートします。アプリが `hono` を依存に追加することはありません。JSX ランタイムは、アプリがすでに持っている `@guren/core` を通じて再エクスポートされています。

```tsx
// app/View/Layout.tsx。すべてのページが自分でラップするドキュメントの骨格
/** @jsxImportSource @guren/core */
import { viteAsset, type FC, type PropsWithChildren } from '@guren/core'

export const Layout: FC<PropsWithChildren<{ head?: unknown }>> = ({ head, children }) => (
  <html lang="ja">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="stylesheet" href={viteAsset('resources/css/app.css')} />
      {head as never}
    </head>
    <body>{children as never}</body>
  </html>
)
```

```tsx
// app/View/ShowPage.tsx。サーバー専用で、ハイドレーションされない
/** @jsxImportSource @guren/core */
import type { FC } from '@guren/core'
import { Layout } from './Layout.js'

type PostView = { slug: string; title: string; description: string; bodyHtml: string }

export const ShowPage: FC<{ post: PostView }> = ({ post }) => (
  <Layout
    head={
      <>
        <title>{post.title} | example.com</title>
        <meta name="description" content={post.description} />
        <link rel="canonical" href={`https://example.com/blog/${post.slug}`} />
      </>
    }
  >
    <article dangerouslySetInnerHTML={{ __html: post.bodyHtml }} />
  </Layout>
)
```

テキストの子要素と属性値は自動的に HTML エスケープされます。タイトルに何が含まれていても `{post.title}` は安全です。この `bodyHtml` の注入が安全なのは、サニタイズするレンダラーの出力だからです。その責任の所在は[セキュリティ境界](#セキュリティ境界)を参照してください。

## Layout パターン

Layout は `<html>` ルートを持つプレーンなコンポーネントで、各ページが自分でラップします。レイアウトのレジストリやミドルウェアはありません。ドキュメントを正しく速く保つルールは 2 つです。

**Layout 自身の `<head>` には、ページが決して上書きしないものだけを置きます**。charset、viewport、スタイルシートのリンク、RSS 発見リンクのようなサイト全体のタグです。ページごとのメタデータ（`<title>`、description、canonical URL）はページコンポーネントに属します。これは単なる整理整頓ではありません。ページがレンダリングしたメタデータは `<head>` に追記されるのであって、置き換えられることはありません。重複排除は Layout のリテラルな子要素を対象にせず、ブラウザは最初に見つけた `<title>` を使います。Layout にハードコードしたデフォルトの `<title>` は、すべてのページのタイトルを静かに覆い隠します。

**ページのメタデータは body ではなく、Layout の `head` スロットで渡します**。ツリーのどこでレンダリングされた `<title>`、`<meta>`、`<link>` もネイティブに `<head>` へ巻き上げ（hoisting）られるので、深くネストしたコンポーネントからでもメタデータを供給できます。ただし hoisting は巻き上げるタグ 1 つごとにドキュメント全体を再走査するため、タグ数に対して二乗のコストがかかります。body に置いた 15 タグの SEO ブロックはレンダリングごとに約 1 ミリ秒を消費し、ページサイズとともに増えます。上の Layout の `head` スロットは同じタグを一定コストで `<head>` に直接レンダリングします。hoisting はツリー深くで出力されるタグのための安全網として残り、スロットが高速経路です。

`<script type="application/ld+json">` と `<style>` は巻き上げられません。書いた場所にそのままレンダリングされます。

## アセット解決: `viteAsset()`

コンテンツページにはスタイルシートの URL が必要で、その URL は環境依存です。`viteAsset(entry)` が両方の分岐を担います。

- **開発時**: Vite 開発サーバーがソースパスを直接配信するため、`viteAsset('resources/css/app.css')` はそのパスの開発サーバー URL を返します。
- **本番**: エントリを Vite ビルドマニフェストから引き、ハッシュ付き出力ファイルを返します。immutable キャッシュ付きで配信されます。

どちらも解決できない場合、`viteAsset()` は試したパスを列挙するエラーを投げます。空文字列を黙って返すことはありません。

知っておくべき要件が 1 つあります。**JS エントリ経由でバンドルされた CSS ファイルは、自分のマニフェストキーを持ちません**。Vite がファイルを出力しマニフェストに記録するよう、スタイルシートを明示的なビルド入力として宣言してください。

```ts
// vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: {
      input: ['resources/js/app.tsx', 'resources/css/app.css'],
    },
  },
  // ...
})
```

### サーバーレスターゲット

サーバーレスのバンドルはビルド出力ディレクトリを伴わずに配備されるため、実行時に読めるマニフェストファイルがありません。デプロイプラグイン（`@guren/plugin-cloudflare`、`@guren/plugin-vercel`、`@guren/plugin-lambda`）はビルドステップでマニフェスト JSON を環境変数 `GUREN_VITE_MANIFEST` に注入し、`viteAsset()` はファイルシステムよりそちらを優先します。アプリ側の設定は不要です。ランタイムが `public/assets/manifest.json` を決して見ないターゲットでも `view()` ページは動作します。

## 完全なドキュメントとフラグメント

ページを Layout でラップし忘れると、失敗は静かに起こります。ページは 200 を返しますが、巻き上げ先の `<head>` がないため、すべての `<title>` と `<meta>` は body 内にインラインのまま残り、スタイルシートもリンクされません。開発中ならスタイルの欠落に気づけますが、クローラーが body から SEO タグを読んでいることに気づくのはずっと後です。

そのため `view()` は大きな音を立てて失敗します。`<html>` をルートとするドキュメントではなくフラグメントをレンダリングしたコンポーネントは、最初のレンダリングで説明的なエラーを投げます。フラグメントを意図している場合（たとえばウィジェット用の HTML 部品）は `{ doctype: false }` を渡してください。

```ts
return this.view(CommentPartial, { comment }, { doctype: false })
```

これでドキュメント検査と `<!doctype html>` の付与が両方スキップされます。

## セキュリティ境界

自動エスケープはマークアップと属性の突破を防ぎます。テキストの子要素にある `<script>` タグはテキストとしてレンダリングされ、属性値の中の `"` が属性を打ち切ることはできません。残りの 2 つはあなたの責任です。

**URL スキームは検証されません**。`href={userProvidedUrl}` は `javascript:` URL をそのまま通します。エスケープは HTML の構造の話であって、リンク先の話ではありません。ユーザー投稿コンテンツは上流でサニタイズしてください。[`@guren/plugin-markdown`](./markdown.md) のサニタイザーは `href`/`src` を `http`、`https`、`mailto` に制限し、その出力は `dangerouslySetInnerHTML` で注入して安全です。サニタイズ済み markdown を View コンポーネントにレンダリングする構成は、まさに guren.dev のブログのパイプラインです。

**JSON-LD には `dangerouslySetInnerHTML` が必要です**。テキストの子要素は HTML エスケープされるため、インライン JSON は壊れてしまいます。構造化データは `<` 文字を `\u003c` にエスケープして出力してください（JSON として妥当なまま、script 要素内で無害になります）。

```tsx
<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
/>
```

## 2 つの JSX 世界を分離する

`view()` と Inertia の両方を使うアプリは、2 つの JSX 方言を含みます。`resources/js/pages/` 配下の React（ブラウザでハイドレーションされる）と、`app/View/` 配下のサーバー専用コンポーネントです。コンパイラはほとんどの取り違えをすでに拒否します。React コンポーネントを `view()` に渡す、View コンポーネントを React ページ内でレンダリングする、注釈付きコンポーネントのプラグマ忘れ、などです。View コンポーネントには必ず `FC<Props>` の明示的な注釈を付けてください。注釈のないコンポーネントは、境界越えをコンパイラが捕捉できない形の 1 つです。

残りは `guren.arch.ts` に境界ルールを追加すれば `bunx guren check` が強制します。

```ts
// guren.arch.ts
import { defineArchRules } from '@guren/cli/arch'

export default defineArchRules({
  rules: [
    // Inertia ページはサーバー専用の View コンポーネントをインポートしてはならない。
    { from: 'resources/js/pages/**', disallow: ['app/View/**', 'modules/*/app/View/**'], includeTypeImports: true },
  ],
})
```

アーキテクチャルール全般については [CLI ガイド](./cli.md)を参照してください。

## 落とし穴

guren.dev のブログ移行で得た教訓です。最初のページを作る前に知っておく価値があります。

- **`view()` ルートへの Inertia `<Link>` は壊れます**。ルートはプレーン HTML を返すため、Inertia クライアントはエラーダイアログを出して拒否します。`view()` ルートへは Inertia ページからでもプレーンな `<a href>` でリンクしてください。
- **日付フォーマットには明示的な `timeZone` を**。サーバーサイドに移った日付フォーマットは、サーバーのタイムゾーンでレンダリングされます。ロサンゼルスのサーバーは UTC の 7 月 1 日を「6 月 30 日」と表示します。`new Intl.DateTimeFormat('ja-JP', { dateStyle: 'long', timeZone: 'UTC' })` のように固定してください。
- **Tailwind に `app/View/` を走査させる**。Tailwind v4 の自動ソース検出はすでにカバーしています。v3 スタイルの `content` グロブを使っている場合は `./app/View/**/*.tsx`（モジュールを使うなら `./modules/*/app/View/**/*.tsx` も）を追加しないと、View コンポーネントのクラスがビルドからパージされます。
- **HMR はありません**。`view()` ページは Vite クライアントを載せないため、ホットリロードの対象がそもそもありません。編集してリロードしてください。これは取引です。自分で足さない限りクライアント JavaScript はゼロです。

## テスト

`view()` レスポンスはプレーン HTML です。ドキュメントのテキストに対してアサートします。

```ts
const response = await controller.show()
const html = await response.text()

expect(response.status).toBe(404)
expect(html).toContain('Post not found')
expect(html).toMatch(/<link rel="stylesheet"/)
```

Vitest でのコントローラー単体テストには、`@guren/testing` の `createControllerModuleMock()` が `view()` をサポートし、`viteAsset()` のモックもエクスポートします（`@guren/testing` 1.7.0 以降が必要です）。どちらも実際のレンダリングエンジンに委譲するため、エスケープ、フラグメントガード、アセット解決は本番とまったく同じ挙動になり、テスト中の `viteAsset()` は決定的な開発サーバー URL を返します。コントローラーテストのヘルパー全般は[テストガイド](./testing.md)を参照してください。

## 次のステップ

- [コントローラー](./controllers.md): 残りのレスポンスヘルパー、バリデーション、ルートモデルバインディング
- [フロントエンド](./frontend.md): Inertia 側。ページ、レイアウト、型安全な props
- [Markdownレンダリング](./markdown.md): コンテンツサイトで `view()` と組み合わせるサニタイズ付き markdown パイプライン

# サーバーレンダリングビュー

`this.view()` は、JSX コンポーネントをサーバーでレンダリングし、ただの HTML レスポンスとして返します。`this.inertia()` と対になる、ハイドレーションしない側の仕組みです。ブログ記事やドキュメント、マーケティングページのように、公開されていて読むのが中心のページに向いています。返すドキュメントにはクライアントのフレームワークも、ハイドレーションも、Inertia のページペイロードのスクリプトも含まれません。guren.dev のブログ記事も、この仕組みで配信しています。

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

`view(component, props, options?)` が受け取るのは JSX 要素ではなく、コンポーネントと props です。そのため、コントローラーは JSX を含まない普通の `.ts` ファイルのままで済みます。props は呼び出し箇所でコンパイル時に検査されるので、prop 名を間違えればその場で型エラーになります。間に codegen を挟む必要もありません。省略できる第 3 引数には、`status` と `headers`、それに `doctype` フラグ（[後述](#完全なドキュメントとフラグメント)）を渡せます。

## `view()` と `this.inertia()` の使い分け

フォームやダッシュボード、クライアント側で画面遷移する画面のように、操作できて状態を持つ UI には `this.inertia()` が向いています。ただし最初のドキュメントのリクエストでは、Inertia はページの props 全体を JSON のスクリプトとして `<head>` に埋め込みます。サーバーサイドレンダリングが有効なら、同じ内容を HTML としても `<body>` にレンダリングします。記事の本文のような大きな prop は、2 回送られることになります。

実際のブログの公開ページを Inertia から移したときに測ると、同じ記事が Inertia の SSR ドキュメントでは 443 KB、サーバーでレンダリングしただけの HTML では 144 KB でした。guren.dev では、この重複したペイロードが圧縮後もかなり残り、docs ページのレスポンスの gzip 後のサイズの 33.7% を占めていました。

| `this.inertia()` を使う | `this.view()` を使う |
|---|---|
| 操作できる UI: フォーム、ダッシュボード、管理画面 | 公開されていて読むのが中心のコンテンツ: ブログ記事、ドキュメント、マーケティングページ |
| ページ間をクライアント側で遷移する画面 | 直接開かれることが多く、クローラー向けの SEO が大事なページ |
| React で状態を持つ画面 | ハイドレーションするほどの動きがないページ |

2 つは 1 つのアプリの中で併用できます。guren.dev のブログも、記事ページは `view()` で配信し、管理画面のエディタは Inertia のままです。

## 最初の View コンポーネント

View コンポーネントは `app/View/*.tsx` に置きます（モジュールの中なら `modules/<name>/app/View/`）。`resources/js/pages/` の下には置かないでください。このディレクトリは、codegen が Inertia のページ用に使っています。View のファイルはどれも `@guren/core` を指す JSX プラグマで始め、型も `@guren/core` から import します。アプリの依存に `hono` を足す必要はありません。JSX ランタイムは、アプリがすでに入れている `@guren/core` から再 export されています。

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

テキストの子要素と属性値は自動で HTML エスケープされるので、タイトルに何が入っていても `{post.title}` は安全です。`bodyHtml` をそのまま注入しても安全なのは、それがサニタイズ済みの出力を返すレンダラーから来ているからです。どこが何に責任を持つかは[セキュリティ境界](#セキュリティ境界)で説明します。

## Layout パターン

Layout は `<html>` をルートに持つ普通のコンポーネントで、各ページが自分自身を Layout で包みます。レイアウトを登録する仕組みやミドルウェアはありません。ドキュメントを正しく、速く保つためのルールは 2 つです。

**Layout 自身の `<head>` には、ページ側で書き直さないものだけを置きます**。charset、viewport、スタイルシートのリンク、RSS の自動検出リンクのような、サイト全体で共通のタグです。ページごとのメタデータ（`<title>`、description、canonical URL）はページのコンポーネントに書きます。見た目の整理だけが理由ではありません。ページがレンダリングしたメタデータは `<head>` に追記されるだけで、既存のタグを置き換えないからです。重複の除去も Layout に直接書かれた子要素には効かず、ブラウザは最初に見つけた `<title>` を使います。そのため Layout に既定の `<title>` を書いておくと、すべてのページのタイトルが気づかないうちにそれで隠れてしまいます。

**ページのメタデータは body に書かず、Layout の `head` スロットで渡します**。ツリーのどこでレンダリングした `<title>`、`<meta>`、`<link>` も `<head>` に自動で巻き上げられる（hoisting）ので、深くネストしたコンポーネントからでもメタデータを出せます。ただし巻き上げは、タグ 1 つごとにドキュメント全体を走査し直すため、タグの数の 2 乗でコストが増えます。15 個のタグからなる SEO ブロックを body に置くと、1 回のレンダリングで約 1 ミリ秒かかり、ページが大きくなるほど遅くなります。上の Layout の `head` スロットを使えば、同じタグを一定のコストで `<head>` に直接レンダリングできます。巻き上げはツリーの深いところで出力されたタグのための保険で、スロットを使うほうが速く済みます。

`<script type="application/ld+json">` と `<style>` は巻き上げられず、書いた場所にそのままレンダリングされます。

## アセット解決: `viteAsset()`

コンテンツのページにはスタイルシートの URL が要りますが、その URL は環境によって変わります。`viteAsset(entry)` は次の 2 通りの場合を引き受けます。

- **開発時**: Vite の開発サーバーがソースのパスを直接配信するので、`viteAsset('resources/css/app.css')` はそのパスを指す開発サーバーの URL を返します。
- **本番**: エントリを Vite のビルドマニフェストから引き、ハッシュ付きの出力ファイルを返します。このファイルは immutable キャッシュ付きで配信されます。

どちらでも解決できないときは、`viteAsset()` は試したパスを並べたエラーを投げます。黙って空文字列を返すことはありません。

1 つ知っておくべき要件があります。**JS のエントリ経由でバンドルされた CSS ファイルは、マニフェストに自分のキーを持ちません**。Vite がファイルを出力してマニフェストに記録するように、スタイルシートをビルドの入力として明示してください。

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

サーバーレスのバンドルはビルドの出力ディレクトリなしで配備されるので、実行時に読めるマニフェストのファイルがありません。そこでデプロイプラグイン（`@guren/plugin-cloudflare`、`@guren/plugin-vercel`、`@guren/plugin-lambda`）は、ビルドの段階でマニフェストの JSON を環境変数 `GUREN_VITE_MANIFEST` に注入します。`viteAsset()` はファイルシステムよりもこの環境変数を優先して読みます。アプリ側の設定は要らず、ランタイムが `public/assets/manifest.json` をまったく読まないターゲットでも `view()` のページは動きます。

## 完全なドキュメントとフラグメント

ページを Layout で包み忘れても、何も目立ったことは起きません。ページは 200 を返しますが、巻き上げ先の `<head>` がないため、`<title>` と `<meta>` はすべて body の中に残り、スタイルシートもリンクされません。スタイルが当たっていないことには開発中に気づけても、クローラーが body から SEO のタグを読んでいることに気づくのはずっと後になります。

そこで `view()` は、このケースをはっきりとエラーにします。`<html>` をルートとするドキュメントではなくフラグメントをレンダリングしたコンポーネントは、最初のレンダリングで理由を説明するエラーを投げます。フラグメントを返したいとき（たとえばウィジェット用の HTML の断片）は、`{ doctype: false }` を渡してください。

```ts
return this.view(CommentPartial, { comment }, { doctype: false })
```

こうすると、ドキュメントかどうかの検査と `<!doctype html>` の付与の両方が行われなくなります。

## セキュリティ境界

自動エスケープによって、マークアップや属性を外から壊されることはありません。テキストの子要素に入った `<script>` タグはテキストとしてレンダリングされ、属性値の中の `"` で属性が途中で閉じることもありません。ただし、次の 2 つは自分で守る必要があります。

**URL のスキームは検証されません**。`href={userProvidedUrl}` は `javascript:` の URL もそのまま通します。エスケープが扱うのは HTML の構造で、リンク先の中身までは見ません。ユーザーが投稿したコンテンツは、手前の段階でサニタイズしてください。[`@guren/plugin-markdown`](./markdown.md) のサニタイザーは `href`/`src` を `http`、`https`、`mailto` に限定するので、その出力は `dangerouslySetInnerHTML` で注入しても安全です。サニタイズ済みの markdown を View コンポーネントでレンダリングする構成は、guren.dev のブログのパイプラインそのものです。

**JSON-LD には `dangerouslySetInnerHTML` が必要です**。テキストの子要素は HTML エスケープされるので、そのまま書いたインラインの JSON は壊れます。構造化データは `<` 文字を `\u003c` にエスケープして出力してください。JSON としては正しいまま、script 要素の中では無害になります。

```tsx
<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
/>
```

## 2 つの JSX 世界を分離する

`view()` と Inertia の両方を使うアプリには、2 種類の JSX が混在します。`resources/js/pages/` の下にある React（ブラウザでハイドレーションされる）と、`app/View/` の下にあるサーバー専用のコンポーネントです。取り違えのほとんどは、コンパイラがすでにエラーにします。React コンポーネントを `view()` に渡した場合や、View コンポーネントを React のページの中でレンダリングした場合、型注釈のあるコンポーネントでプラグマを書き忘れた場合などです。View コンポーネントには、必ず `FC<Props>` の型注釈を明示してください。注釈のないコンポーネントが境界をまたいでも、コンパイラには見つけられないことがあります。

残りの取り違えは、`guren.arch.ts` に境界のルールを足せば `bunx guren check` で検出できます。

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

アーキテクチャのルール全般は [CLI ガイド](./cli.md)で説明しています。

## 落とし穴

guren.dev のブログを移行したときにわかったことです。最初のページを作る前に目を通しておいてください。

- **`view()` のルートに Inertia の `<Link>` でリンクすると壊れます**。ルートが返すのはただの HTML なので、Inertia のクライアントがエラーダイアログを出して受け付けません。`view()` のルートには、Inertia のページからでも普通の `<a href>` でリンクしてください。
- **日付の書式には `timeZone` を明示します**。日付の書式処理をサーバー側に移すと、サーバーのタイムゾーンでレンダリングされます。ロサンゼルスのサーバーなら、UTC の 7 月 1 日を「6 月 30 日」と表示してしまいます。`new Intl.DateTimeFormat('ja-JP', { dateStyle: 'long', timeZone: 'UTC' })` のようにタイムゾーンを固定してください。
- **Tailwind に `app/View/` を読ませます**。Tailwind v4 のソース自動検出なら、すでに対象に入っています。v3 形式の `content` グロブを使っている場合は、`./app/View/**/*.tsx`（モジュールを使うなら `./modules/*/app/View/**/*.tsx` も）を加えてください。加えないと、View コンポーネントで使ったクラスがビルドから削られます。
- **HMR はありません**。`view()` のページには Vite のクライアントが載らないので、ホットリロードする対象がありません。編集したらブラウザを再読み込みしてください。その代わり、自分で足さない限りクライアントの JavaScript は一切送られません。

## テスト

`view()` のレスポンスはただの HTML なので、ドキュメントのテキストに対してアサートします。

```ts
const response = await controller.show()
const html = await response.text()

expect(response.status).toBe(404)
expect(html).toContain('Post not found')
expect(html).toMatch(/<link rel="stylesheet"/)
```

Vitest でコントローラーを単体テストするときは、`@guren/testing` の `createControllerModuleMock()` が `view()` に対応しています。`viteAsset()` のモックも export されています（`@guren/testing` 1.7.0 以降が必要です）。どちらも実際のレンダリングエンジンに処理を渡すので、エスケープ、フラグメントの検査、アセットの解決は本番とまったく同じように動きます。テスト中の `viteAsset()` は、決まった開発サーバーの URL を返します。コントローラーのテスト用ヘルパー全般は[テストガイド](./testing.md)を参照してください。

## 次のステップ

- [コントローラー](./controllers.md): ほかのレスポンスヘルパー、バリデーション、ルートモデルバインディング
- [フロントエンド](./frontend.md): Inertia 側のページ、レイアウト、型安全な props
- [Markdownレンダリング](./markdown.md): コンテンツサイトで `view()` と組み合わせる、サニタイズ付きの markdown パイプライン

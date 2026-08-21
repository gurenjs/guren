# Markdownレンダリング

`@guren/plugin-markdown`は、堅牢なデフォルト設定でmarkdownをHTMLにレンダリングします。GitHub Flavored Markdown、`dangerouslySetInnerHTML`に安全なサニタイズ済み出力、GitHubスタイルのアラート、見出しアンカー、そしてオプションのshikiコードハイライトを備えています。guren.dev自身のdocsとブログが使っているパイプラインです。

## インストール

```bash
bunx guren plugin @guren/plugin-markdown
bun add @guren/plugin-markdown
```

## レンダリング

```ts
import { createMarkdownRenderer } from '@guren/plugin-markdown'

const renderer = createMarkdownRenderer()
const html = await renderer.render('# Hello\n\n> [!NOTE]\n> デフォルトでサニタイズされます。')
```

`render()`は入力に対する純粋な非同期関数です。1つのレンダラインスタンスは並行リクエスト下でも安全で、パッケージはキャッシュを持ちません。保存時にレンダリングしてHTMLを格納する（ブログのパターン）か、リクエストごとにレンダリングするかはアプリ側の選択です。

全オプションとデフォルト値:

```ts
createMarkdownRenderer({
  gfm: true,        // テーブル、取り消し線、オートリンク
  sanitize: true,   // 出力をallowlistでサニタイズ（後述）
  alerts: true,     // GitHubスタイルの > [!NOTE] blockquoteアラート
  anchors: true,    // 見出しのid属性
  rewriteLink: undefined,   // (href: string) => string
  highlight: undefined,     // コードフェンスのハイライタ（後述）
})
```

## サニタイズ

markdown記法だけでも`javascript:`や`data:`のURLは`href`や`src`に入り込めるため、生HTMLのエスケープだけでは不十分です。デフォルトの`sanitize: true`では、レンダリング結果は返される前に`sanitize-html`のallowlistを通過します。

- 構造タグのみ許可。`<script>`のような生HTMLは黙って消えるのではなくエスケープされます
- `href`/`src`は`http`、`https`、`mailto`に限定。プロトコル相対URL（`//host/path`）は拒否されます
- インラインstyleはshikiが出力する宣言（色と`--shiki-dark`カスタムプロパティ）だけに限定されるため、ハイライト済みコードはサニタイズを無傷で通過します
- 見出しの`id`とアラートのマークアップは、値の完全一致で許可されます

結果は`dangerouslySetInnerHTML`で安全に注入できます。

allowlistの拡張はコールバックで行います。デフォルト値を受け取り、使用するオプションを返します:

```ts
createMarkdownRenderer({
  sanitize: (defaults) => ({
    ...defaults,
    allowedTags: [...(defaults.allowedTags as string[]), 'video'],
  }),
})
```

信頼済みコンテンツ（ビルド時にレンダリングする自分のdocsなど）には、`sanitize: false`で明示的にオプトアウトします。

## アラート

GitHubの5つのblockquoteディレクティブは、ラベル付きのアラートブロックとしてレンダリングされます:

```markdown
> [!NOTE]
> 知っておくべきこと。

> [!WARNING]
> 確認すべきこと。
```

マークアップにはフレームワーク中立なクラス名（`guren-markdown-alert`、`guren-markdown-alert--note`〜`--caution`、`__label`、`__body`）が付き、パッケージ自体はスタイルを適用しません。[スタイリング](#スタイリング)を参照してください。

`alertLabels`はタイプごとのラベル文字列を上書きします（`@guren/plugin-markdown` 0.2.0以降）。i18nや別の語彙のために使え、複数タイプで1つのラベルを共有できます。クラス名は書かれたディレクティブに紐づいたまま変わらず、ラベルはエスケープ済みテキストとしてレンダリングされます:

```ts
createMarkdownRenderer({
  alertLabels: { note: 'note', tip: 'ok', important: 'rule', warning: 'rule', caution: 'never' },
})
```

明示的な空文字列はラベル文字列を抑止します。省略したタイプはデフォルトのラベル（`Note`、`Tip`、`Important`、`Warning`、`Caution`）を保ちます。

## 見出しアンカー

`anchors: true`ではすべての見出しにslugの`id`が付きます。unicode対応で、1レンダリング内の重複にも安全です（`Setup`、`Setup-1`、`Setup`は`setup`、`setup-1`、`setup-2`になります）。見出しテキストに紛れ込ませたHTMLに対しても堅牢化されています。

## リンクの書き換え

`rewriteLink`はレンダリング前にすべてのリンクの`href`に対して実行されます。たとえば、GitHub互換の相対`.md`リンクをサイトのルートに変換できます:

```ts
createMarkdownRenderer({
  rewriteLink: (href) => (href.endsWith('.md') ? `/docs/${href.slice(0, -3)}` : href),
})
```

## shikiによるコードハイライト

`shiki`は専用サブパスの背後にあるoptional peer dependencyです。使う場合だけインストールします:

```bash
bun add shiki
```

```ts
import { createMarkdownRenderer } from '@guren/plugin-markdown'
import { createShikiHighlight } from '@guren/plugin-markdown/shiki'

const renderer = createMarkdownRenderer({
  highlight: createShikiHighlight({
    themes: { light: 'github-light', dark: 'github-dark' },
    langs: ['typescript', 'tsx', 'bash', 'json'],
  }),
})
```

これはfine-grainedな`shiki/core`ハイライタを構築します。列挙した文法だけを読み込み、oniguruma WASMの代わりにJavaScript正規表現エンジンを使います。出力はデュアルテーマで、ライトパレットはインライン、ダークパレットは`--shiki-dark`カスタムプロパティに載ります。未ロード言語のフェンスは例外を投げずプレーンテキストにフォールバックします。

### Cloudflare Workersでは

すべてのimportを静的に解決する必要があるバンドラは、実行時の文法名解決ができません。代わりに明示的なモジュールthunkを渡します。thunkはロードを遅延させる効果もあり、モジュールのimport自体は初回レンダリングまでコストゼロです:

```ts
createShikiHighlight({
  themes: { light: 'github-light', dark: 'github-dark' },
  themeModules: [
    () => import('shiki/dist/themes/github-light.mjs'),
    () => import('shiki/dist/themes/github-dark.mjs'),
  ],
  langModules: [() => import('shiki/dist/langs/typescript.mjs')],
})
```

Workersバンドルに入るコードでフルの`shiki`エントリをimportしてはいけません。全文法とoniguruma WASMを引き込みます。ビルド時コード（docsのプリレンダリングなど）では、バンドルサイズより任意言語対応が重要なのでフルエントリで問題ありません。

### カスタムハイライタ

`highlight`は単なる関数`(code, lang) => string | Promise<string>`です。`<pre`で始まる結果は完全なコードブロックとしてそのまま出力され（shikiの形）、それ以外はデフォルトの`<pre><code>`でラップされます。

## スタイリング

レンダラはクラス名だけを出力し、スタイルは適用しません。アラートとダークモードのshiki切替をカバーする小さな参照スタイルシートが同梱されています:

```ts
import '@guren/plugin-markdown/styles.css'
```

アラートのアクセント色はCSSカスタムプロパティなので、変数の上書きだけで再スタイルできます:

```css
.guren-markdown-alert--note { --guren-markdown-alert-accent: #e11d48; }
```

## コンテナサービスとして

`markdownPlugin()`は設定済みレンダラを`markdown`コンテナサービスとして登録します:

```ts
import { createApp } from '@guren/core'
import { markdownPlugin } from '@guren/plugin-markdown'

createApp({
  providers: [markdownPlugin({ /* レンダラのオプション */ })],
})
```

```ts
import type { MarkdownRenderer } from '@guren/plugin-markdown'

const renderer = container.make<MarkdownRenderer>('markdown')
```

プラグイン形態はオプションです。`createMarkdownRenderer`は`createApp`なしでも動作します。

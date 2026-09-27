# Markdownレンダリング

`@guren/plugin-markdown`は、markdownをHTMLにレンダリングするプラグインです。デフォルト設定のままで安全に使えるようにしてあり、GitHub Flavored Markdown、`dangerouslySetInnerHTML`に渡しても安全なサニタイズ済みの出力、GitHubスタイルのアラート、見出しアンカーに対応し、shikiによるコードハイライトも追加できます。guren.dev自身のdocsとブログも、このパイプラインでレンダリングしています。

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

`render()`は、入力だけで結果が決まる非同期関数です。パッケージはキャッシュを持たないので、1つのレンダラインスタンスを並行するリクエストで共有しても問題ありません。保存時にレンダリングしてHTMLを保存しておくか（ブログではこの方式です）、リクエストのたびにレンダリングするかは、アプリ側で決めてください。

オプションとそのデフォルト値は次のとおりです。

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

markdownの記法だけでも、`href`や`src`に`javascript:`や`data:`のURLを入れられます。そのため、生のHTMLをエスケープするだけでは足りません。デフォルトの`sanitize: true`では、レンダリングしたHTMLを返す前に`sanitize-html`の許可リスト（allowlist）に通します。

- 許可するのは構造を表すタグだけです。`<script>`のような生のHTMLは、黙って消さずにエスケープします
- `href`と`src`に使えるのは`http`、`https`、`mailto`だけで、プロトコル相対URL（`//host/path`）は拒否します
- インラインのstyleは、shikiが出力する宣言（色と`--shiki-dark`カスタムプロパティ）だけを許可します。そのため、ハイライトしたコードはサニタイズ後もそのまま残ります
- 見出しの`id`とアラートのマークアップは、値が完全に一致する場合に限って許可します

こうして得られた結果は、`dangerouslySetInnerHTML`で安全に埋め込めます。

許可リストを置き換えずに広げたい場合は、コールバックを渡します。コールバックはデフォルト値を受け取り、実際に使うオプションを返します。

```ts
createMarkdownRenderer({
  sanitize: (defaults) => ({
    ...defaults,
    allowedTags: [...(defaults.allowedTags as string[]), 'video'],
  }),
})
```

ビルド時にレンダリングする自分のdocsのように、信頼できるコンテンツであれば、`sanitize: false`を指定して明示的にサニタイズを外せます。

## アラート

GitHubの5種類のblockquoteディレクティブは、ラベル付きのアラートブロックとしてレンダリングされます。

```markdown
> [!NOTE]
> 知っておくべきこと。

> [!WARNING]
> 確認すべきこと。
```

マークアップには、特定のフレームワークに依存しないクラス名（`guren-markdown-alert`、`guren-markdown-alert--note`〜`--caution`、`__label`、`__body`）が付きます。パッケージ自体はスタイルを当てないので、[スタイリング](#スタイリング)を参照してください。

`alertLabels`を使うと、表示するラベルの文字列をタイプごとに上書きできます（`@guren/plugin-markdown` 0.2.0以降）。i18nや、別の言葉づかいに合わせたいときに使ってください。複数のタイプで同じラベルを使っても構いません。クラス名は書かれたディレクティブのまま変わらず、ラベルはエスケープしたテキストとしてレンダリングされます。

```ts
createMarkdownRenderer({
  alertLabels: { note: 'note', tip: 'ok', important: 'rule', warning: 'rule', caution: 'never' },
})
```

空文字列を明示的に指定すると、ラベルの文字列は表示されません。指定しなかったタイプは、デフォルトのラベル（`Note`、`Tip`、`Important`、`Warning`、`Caution`）のままです。

## 見出しアンカー

`anchors: true`では、すべての見出しにslugの`id`が付きます。slugはunicodeに対応しており、1回のレンダリングの中で重複しても番号で区別されます（`Setup`、`Setup-1`、`Setup`は`setup`、`setup-1`、`setup-2`になります）。見出しのテキストにHTMLが紛れ込んでいても壊れません。

## リンクの書き換え

`rewriteLink`は、レンダリングの前にすべてのリンクの`href`に対して呼ばれます。たとえば、GitHubでも動く相対`.md`リンクを、サイトのルートに変換できます。

```ts
createMarkdownRenderer({
  rewriteLink: (href) => (href.endsWith('.md') ? `/docs/${href.slice(0, -3)}` : href),
})
```

## shikiによるコードハイライト

`shiki`は専用のサブパスから読み込むoptional peer dependencyなので、使う場合だけインストールしてください。

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

このコードは、必要な部分だけを読み込む（fine-grainedな）`shiki/core`のハイライタを組み立てます。読み込む文法は列挙したものだけで、正規表現エンジンにはoniguruma WASMではなくJavaScriptのものを使います。出力はデュアルテーマで、ライトのパレットはインラインに、ダークのパレットは`--shiki-dark`カスタムプロパティに入ります。読み込んでいない言語のフェンスは、例外を投げずにプレーンテキストとして出力します。

### Cloudflare Workersでは

importをすべて静的に解決しなければならないバンドラでは、文法名を実行時に解決できません。その場合は、モジュールを読み込むthunkを明示的に渡します。thunkを使うとロードも遅れるので、初回のレンダリングまではモジュールのimportにコストがかかりません。

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

Workersのバンドルに入るコードでは、`shiki`のフルエントリをimportしないでください。すべての文法とoniguruma WASMまで取り込まれてしまいます。docsのプリレンダリングのようにビルド時だけ動くコードでは、バンドルサイズよりどの言語でも扱えることのほうが大事なので、フルエントリを使って構いません。

### カスタムハイライタ

`highlight`は、`(code, lang) => string | Promise<string>`という形のただの関数です。結果が`<pre`で始まる場合は完成したコードブロックとみなしてそのまま出力し（shikiの出力がこの形です）、それ以外はデフォルトの`<pre><code>`で包みます。

## スタイリング

レンダラはクラス名を出力するだけで、スタイルは当てません。アラートと、ダークモードでのshikiの切り替えを扱う小さな参考用スタイルシートを同梱しています。

```ts
import '@guren/plugin-markdown/styles.css'
```

アラートのアクセントカラーはCSSカスタムプロパティなので、変数を上書きするだけで見た目を変えられます。

```css
.guren-markdown-alert--note { --guren-markdown-alert-accent: #e11d48; }
```

## コンテナサービスとして

`markdownPlugin()`を使うと、設定したレンダラが`markdown`という名前のコンテナサービスとして登録されます。

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

プラグインとして登録するかどうかは任意です。`createMarkdownRenderer`は`createApp`がなくても動きます。

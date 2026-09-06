# 第 1 章: ゼロから出荷できるアプリへ

この章では Guren アプリを雛形生成し、雛形が何を用意してくれたのかを読み、テストを先に置いた上で変更をひとつ手で加え、変更をひとつコーディングエージェントに委ねてハーネスがその仕事を検査する様子を見届け、最後にどこでも動かせるコンテナイメージを手にします。以降のすべての章も同じ形で終わります。ゲートが緑で、コミット済みで、出荷できる状態です。

この章だけは [4 拍子](./00-overview.md#各章の進み方) に従いません。準備の章なので、まだ手で組むものがありません。代わりに、以降のすべての章が前提にする道具を覚えます。テストランナー、`guren gate`、そしてエージェントハーネスです。

**この章で学ぶこと:**

- すべての選択をあらかじめ指定してアプリを雛形生成し、本文と同じアプリにする方法
- 新規アプリに何が同梱されているか: テスト、CI ワークフロー、エージェントハーネス
- `bunx guren gate` が何を実行するのか、そしてそれがなぜ CI と同じコマンドなのか
- `.claude/settings.json` の 3 つの hook が `guren check` と `guren gate` の結果をどうエージェントに返すのか
- 変更の前に失敗するテストを書き、それを通す方法
- `guren deploy` でアプリをコンテナイメージにする方法

## 1. アプリを雛形生成する

対話的に実行すると、雛形生成ツールは 4 つの質問をします。代わりにコマンドラインで答えてしまい、このコースが説明するアプリと同じものにしましょう。

```bash run
bunx create-guren-app guren-blog --mode ssr --db sqlite --agents claude --git
```

- `--mode ssr` はページをまずサーバー側でレンダリングします。もうひとつの `spa` は空の殻を送ってブラウザ側でレンダリングします。
- `--db sqlite` はデータベースサーバーを必要としません。ファイルは最初に開かれたときに `./data/` 配下に作られます。第 14 章で同じアプリを Postgres に載せ替えます。
- `--agents claude` は Claude Code 向けのエージェントハーネスを導入します。`--agents all` なら Claude Code、Codex、Cursor、Copilot、OpenCode 向けを一度に導入し、`none` なら省略します。このコースの内容はどのエージェントでも成り立ちます。それを成り立たせているのがハーネスです。
- `--git` はリポジトリを初期化して最初のコミットを作ります。これで各章をコミットで締められます。

雛形生成ツールはテンプレートをコピーし、生成した `APP_KEY` と `DATABASE_URL=./data/guren.db` を持つ `.env` を書き、依存関係をインストールします。アプリに入りましょう。

```bash run
cd guren-blog
```

## 2. 動かす

```bash run background
bun run dev
```

**チェックポイント:** [http://localhost:3333](http://localhost:3333) を開きます。「Welcome to Guren Blog!」と見出しの付いたウェルカムページと、その下に 6 枚の機能カードが見えるはずです。

`dev` スクリプトは 3 つのことをします。`.guren/` 配下の型付きマニフェストを再生成し(`bun run codegen`)、`GUREN_MCP=1` と `GUREN_DOCS=1` を付けてサーバーを起動します。この 2 つのフラグは、開発時専用の MCP エンドポイントを `/_guren/mcp` に、Docs Graph ビューアを `/_guren/docs` にマウントします。第 8 章で前者にエージェントを接続し、第 13 章で後者を埋めます。どちらも本番には存在しません。

このターミナルでは開発サーバーを動かしたままにしてください。以降のコマンドはすべて、`guren-blog` の中で、別のターミナルから実行します。

## 3. 用意されたものを読む

新規アプリは一度に読み切れる大きさです。この章で触れるファイルは次のとおりです。

```text
guren-blog/
├── app/Http/Controllers/HomeController.ts   # 唯一のコントローラー
├── resources/js/pages/Home.tsx              # 唯一のページ
├── routes/web.ts                            # 2 本のルート
├── lang/en/messages.json                    # 翻訳カタログ
├── tests/HomeController.test.ts             # 唯一のテスト
├── .github/workflows/ci.yml                 # CI: ゲートひとつ
├── CLAUDE.md                                # エージェントが最初に読むもの
├── .claude/                                 # rules、skills、agents、hooks
└── .mcp.json                                # 開発用 MCP エンドポイント
```

### リクエストの経路

`routes/web.ts` は 2 つの URL を対応付けます。ひとつ目はコントローラーのメソッドを指名し、ふたつ目はインラインで書いたハンドラーです。一行で済むものならこれで構いませんが、それより大きいものには向きません。

```ts
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

`HomeController.index` はページの props を組み立ててページをレンダリングします。`pages.Home` は文字列ではありません。`resources/js/pages/` 配下のファイルから生成された型付きの参照で、受け取れる props はページコンポーネントの `Props` インターフェースそのものです。ページが宣言していない prop を渡したり、必須の prop を落としたりすると、`bun run typecheck` が失敗します。

```ts
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class HomeController extends Controller {
  async index(): Promise<Response> {
    const props = {
      // Message text lives in lang/en/messages.json (key typed by codegen).
      message: this.t('messages.welcome', { name: 'Guren Blog' }),
    }

    return this.inertia(pages.Home, props, { title: 'Guren Blog' })
  }
}
```

`this.t()` は `lang/en/messages.json` を読み、そのキーも型付きです。`messages.welcome` は存在し、`messages.hello` はコンパイルが通りません。Guren が実行時の間違いをコンパイルエラーに変える、数多くの場所の最初のひとつです。

### テスト

`tests/HomeController.test.ts` は本物の `src/app.ts` を起動し、ポートもブラウザも使わずにリクエストを投げます。

```ts
import { beforeAll, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

// Boots the real src/app.ts so tests share its configuration.
describe('app', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  it('serves the translated home page', async () => {
    const response = await http.get('/').assertOk()
    await response.assertBodyContains('Welcome to')
  })

  it('answers the health check', async () => {
    await http.get('/health').assertOk()
  })
})
```

実行します。

```bash run
bun test
```

テストは 2 件、どちらも緑です。第 2 章からは、このようなテストをコードより*先に*書きます。

### CI ワークフロー

`.github/workflows/ci.yml` で重要なステップはひとつだけです。

```yaml
      - name: Gate
        run: bunx guren gate --deps
```

これが CI のすべてです。CI が検査するものは、同じコマンドで手元でも実行できます。

## 4. ゲート

```bash run
bunx guren gate
```

`gate` は 6 つのステージを順に実行し、最初の失敗で止まります。**codegen**(型付きマニフェスト)、**typecheck**、**lint**、**check**、**audit**、**test** です。うち 2 つは Guren 固有のものです。

- `guren check` は動いているアプリではなくコードを読み、すべてのルートが実在するコントローラーメソッドを指しているか、すべての `pages.X` が実在するページファイルを指しているか、各ページの props がコントローラーの送るものと一致しているか、その他、放っておけば実行時に落ちる十数項目を検証します。
- `guren audit` は静的なセキュリティレビューです。バリデーションや認証の無い変更系ルート、生 SQL、ソース内のシークレット、マスアサインメント。新規アプリでは何も言いません。

このコースはこれらのステージのひとつの性質に寄りかかっています。コードを書いたのが人間でもエージェントでも、ステージは同じだということです。それが次の節を可能にしています。

## 5. ハーネス

`--agents claude` は `CLAUDE.md`、`.claude/`、`.mcp.json` を書きました。これらをまとめて**エージェントハーネス**と呼びます。エージェントが書く前に読むもの、編集した後に走るもの、停止を許される前に走るものです。

`.claude/settings.json` を開いてください。重要なのは 3 つの hook です。

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "bunx guren context 2>/dev/null || true" }] }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "bun .claude/hooks/check-after-edit.ts" }]
      }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bun .claude/hooks/gate-on-stop.ts", "timeout": 300 }] }
    ]
  }
}
```

- **`SessionStart`** は、エージェントの最初のターンの前に `bunx guren context` の出力をコンテキストへ注入します。すべてのモデル、ルート、コントローラー、ページの地図で、末尾にはフレームワークの API シグネチャのダイジェストが付きます。エージェントは `node_modules` を読むことなく、プロジェクトが何かを知った状態で始まります。
- **`PostToolUse`** はファイル編集のたびに走ります。そのファイルがルート、コントローラー、モデル、スキーマ、ページのいずれかなら、`.claude/hooks/check-after-edit.ts` が `guren check` を実行し、指摘をそのままエージェントに返します。修正は同じターンの中で起こります。
- **`Stop`** は、エージェントが未コミットの変更を残したままターンを終えようとしたときに走ります。`.claude/hooks/gate-on-stop.ts` が `guren gate` を実行し、どれかのステージが失敗すれば停止は一度ブロックされ、指摘が返ってきます。ゲートが赤いうちは、エージェントは変更を完了と宣言できません。

エージェントに見えているものを見てみましょう。

```bash run
bunx guren context
```

`.claude/` の残りは、開始時ではなく必要になったときに読まれます。

- **`rules/`** には領域ごとに検証済みの API ルールがあります(`orm-models.md`、`controllers-http.md`、`routes-codegen.md`、`testing.md`、`docs-and-spec.md`、`comments.md`)。それぞれが適用対象のファイル glob を宣言しているので、エージェントはルートを編集するときに `routes-codegen.md` を読み込み、それまでは読みません。
- **`skills/`** はエージェントが求めに応じて従う手順です。`scaffold`(ファイルを手打ちせず `bunx guren make:*` に手を伸ばす)、`feature`、`db-manage`、`guren-api`、`agent-interface`、`plugin-authoring`、`dev-workflow`。
- **`agents/`** は独自の brief を持つ 2 つの subagent、`code-review` と `test-writer` です。
- **`.mcp.json`** は `dev` スクリプトがマウントした開発用 MCP エンドポイントをエージェントに指し示し、動いているアプリに問い合わせられるようにします。

以降の各章でこれらをひとつずつ使い、第 8 章では自分で書きます。今は、この後で見守ることになる 2 つの hook に注目してください。

## 6. 最初の変更を、手で

ホームページにタグラインを付けます。以降のすべての章と同じ順序で進めます。まずテスト、それから変更です。

タグラインも期待するようにテストファイルを置き換えます。

```ts file=tests/HomeController.test.ts
import { beforeAll, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

// Boots the real src/app.ts so tests share its configuration.
describe('app', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  it('serves the translated home page', async () => {
    const response = await http.get('/').assertOk()
    await response.assertBodyContains('Welcome to')
  })

  it('shows the tagline', async () => {
    const response = await http.get('/').assertOk()
    await response.assertBodyContains('A blog, built the Guren way')
  })

  it('answers the health check', async () => {
    await http.get('/health').assertOk()
  })
})
```

実行して、失敗するのを見届けてください。これは意図的です。一度も失敗したことのないテストは、何も証明していません。

```bash run expect-fail
bun test
```

では通しましょう。タグラインはウェルカムメッセージと同じく prop です。コントローラーが送り、ページが `Props` で宣言してレンダリングします。`app/Http/Controllers/HomeController.ts` を置き換えます。

```ts file=app/Http/Controllers/HomeController.ts
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class HomeController extends Controller {
  async index(): Promise<Response> {
    const props = {
      // Message text lives in lang/en/messages.json (key typed by codegen).
      message: this.t('messages.welcome', { name: 'Guren Blog' }),
      tagline: 'A blog, built the Guren way',
    }

    return this.inertia(pages.Home, props, { title: 'Guren Blog' })
  }
}
```

そして `resources/js/pages/Home.tsx` を置き換えます。変更点は `Props` の `tagline` フィールドと、それをレンダリングする段落の 2 か所で、残りは雛形のページそのままです。

```tsx file=resources/js/pages/Home.tsx
import { Head } from '@inertiajs/react'
interface Props {
  message: string
  tagline: string
}

const features = [
  { title: 'Routing & Controllers', desc: 'Laravel-style MVC with type-safe route helpers' },
  { title: 'Eloquent-style ORM', desc: 'Drizzle-powered models with relations, scopes, and soft deletes' },
  { title: 'Inertia + React', desc: 'SPA-like UX without maintaining a separate frontend' },
  { title: 'Auth & Sessions', desc: 'Built-in authentication with guards, policies, and API tokens' },
  { title: 'Queue & Mail', desc: 'Background jobs, email sending, and event broadcasting' },
  { title: 'Zero-config SQLite', desc: 'No Docker needed — just bun install && bun run dev' },
]

export default function Home({ message, tagline }: Props) {
  return (
    <>
      <Head title="Guren Blog" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl px-6 py-20">
          <p className="mb-5 font-mono text-xs tracking-[0.18em] uppercase text-g-text-2">
            Powered by Bun + Hono
          </p>
          <h1 className="mb-4 flex items-center gap-4 text-5xl font-bold tracking-tight text-g-heading">
            <span aria-hidden className="h-10 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
            {message}
          </h1>
          <p className="mb-8 text-lg text-g-text-2">{tagline}</p>

          <div className="mb-12 flex flex-wrap gap-3">
            <a
              href="https://guren.dev/docs"
              className="inline-flex items-center rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down"
            >
              Documentation
            </a>
            <a
              href="https://github.com/gurenjs/guren"
              className="inline-flex items-center rounded-g-ctl border border-g-line-strong bg-g-panel px-4 py-2 text-sm font-bold text-g-text transition hover:border-g-muted"
            >
              GitHub
            </a>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {features.map((f) => (
              <div
                key={f.title}
                className="rounded-g-card border border-g-line bg-g-panel p-5 shadow-g-card"
              >
                <h3 className="mb-1 font-bold text-g-heading">{f.title}</h3>
                <p className="text-sm text-g-text-2">{f.desc}</p>
              </div>
            ))}
          </div>

          <div className="mt-12 rounded-g-card bg-g-ink p-6">
            <h2 className="mb-3 font-mono text-xs tracking-[0.18em] uppercase text-g-on-ink-muted">
              Next steps
            </h2>
            <div className="space-y-2 font-mono text-sm text-g-on-ink">
              <p><span className="text-g-on-ink-muted">$</span> bunx guren add auth</p>
              <p><span className="text-g-on-ink-muted">$</span> bunx guren add resource posts</p>
              <p><span className="text-g-on-ink-muted">$</span> bunx guren make:model Post</p>
            </div>
          </div>
        </div>
      </main>
    </>
  )
}
```

```bash run
bun test
```

テストは 3 件、緑です。ブラウザをリロードすると、タグラインが表示されています。もし `tagline` をコントローラーに足してページに足し忘れていたら、あるいはその逆なら、`bunx guren gate` は **typecheck** で止まっていました。コントローラーの呼び出しは `Props` インターフェースに対して検査されるからです。変更全体が成り立っていることをゲートで確かめ、コミットします。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add a tagline to the home page"
```

## 7. 変更をエージェントに委ねる

今度は同じ種類の変更をエージェントにやらせ、hook の動きを見守ります。`guren-blog` の中でエージェントを起動してください(Claude Code なら `claude`)。`SessionStart` hook のおかげで、最初のメッセージには手順 5 で表示したプロジェクトの地図がすでに載っています。こう尋ねます。

> Explain this project: what does `bunx guren context` report, which hook runs when you edit `routes/web.ts`, and which one runs when you end a turn with uncommitted changes?

答えを `.claude/settings.json` と照らして読んでください。3 つの hook すべてと、それぞれが実行するものを挙げているはずです。`guren gate` に触れていなければ、`CLAUDE.md` を読んでいません。仕事を任せる前に、自分のエージェントについて知っておく価値のあることです。

次に仕事を任せます。

> Move the tagline text out of `HomeController` into `lang/en/messages.json` as `messages.tagline`, and read it through `this.t()` like the welcome message. Keep the tests unchanged and green.

トランスクリプトで 2 つのことを見守ってください。

1. エージェントが `HomeController.ts` を編集すると、`PostToolUse` hook が `guren check` を実行して報告します。きれいな編集なら何も言いません。エージェントがキーを打ち間違えていれば、`check` の指摘がエージェントの次の一手より先に届きます。
2. エージェントが終えようとすると、`Stop` hook が `guren gate` を実行します。codegen が型付き翻訳キーを再生成し、typecheck が `messages.tagline` の存在を確かめ、テストが走ります。すべてのステージが緑になって初めてターンが終わります。

**手元にエージェントが無い場合は、** 同じ変更を手で加えてください。対象は 2 ファイルです。

```json file=lang/en/messages.json fallback
{
  "welcome": "Welcome to :name!",
  "tagline": "A blog, built the Guren way"
}
```

```ts file=app/Http/Controllers/HomeController.ts fallback
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class HomeController extends Controller {
  async index(): Promise<Response> {
    const props = {
      // Message text lives in lang/en/messages.json (keys typed by codegen).
      message: this.t('messages.welcome', { name: 'Guren Blog' }),
      tagline: this.t('messages.tagline'),
    }

    return this.inertia(pages.Home, props, { title: 'Guren Blog' })
  }
}
```

どちらの場合も、受け入れる前に結果をレビューしてください。これが以降のすべての章でエージェントの出力に対して示される rubric で、最初のものは短いです。

- `HomeController.ts` はタグラインを `this.t('messages.tagline')` で読み、英語の文言を含んでいない。
- `lang/en/messages.json` に `tagline` キーがある。それ以外は変わっていない。
- `tests/HomeController.test.ts` は手つかずで緑。
- `bunx guren gate` が緑。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "refactor: read the tagline from the translation catalog"
```

これで、このコースの残りが交互に繰り返す 2 つのことを両方やりました。テストを先に置いて自分で書いた変更と、仕様化して委ね、検証した変更です。

## 8. 出荷する

Guren は本番用の Dockerfile を書いてくれます。

```bash run
bunx guren deploy --target docker
```

書き出された `Dockerfile` を開いてください。2 段階のビルドです。第 1 段階ですべてをインストールして `bun run build` を実行し、第 2 段階では実行時に必要なディレクトリ(`bin/`、`src/`、`app/`、`config/`、`routes/`、`public/`、`db/`、`.guren/`)だけをスリムなイメージにコピーして、`NODE_ENV=production` で `bun bin/serve.ts` を起動します。Docker が入っていれば、イメージをビルドして動かしてみましょう。

```bash manual
docker build -t guren-blog .
docker run --rm -p 3333:3333 --env-file .env guren-blog
```

もう一度 [http://localhost:3333](http://localhost:3333) を開きます。同じページですが、今度はコンテナの中で動くアプリの本番ビルドが返しています。誰のマシンでも同じように動くものです。Ctrl-C で止めてください。注意点が 2 つあり、どちらも第 14 章で解決します。コンテナは開発用の `.env` を読んでいること、そして SQLite ファイルがコンテナの中にあるので、止めるとすべて忘れることです。

レシピをコミットします。

```bash run
git add -A
git commit -m "chore: add the Docker recipe"
```

**どこでホストするか**はあなたの選択で、コースはそれに依存しません。`bunx guren deploy --target fly` と `--target railway` は、同じ Dockerfile の隣にそれぞれのプラットフォームが求める追加設定を書きます。コンテナイメージが動くホスト(Render、Koyeb、Docker の入った VPS)なら Dockerfile だけで動きます。第 14 章で、Postgres、データベースバックのセッション、その前に立つ CI ゲートを備えた本物のデプロイを一通り行います。

## いまいる場所

- SSR と SQLite で動く Guren アプリ。git 管理下で、自分のコミットが 3 つ。
- 赤と緑の両方を見たテストスイート。
- CI が実行するゲート、そしてそれが自分の実行するものと同じだという知識。
- `guren check` と `guren gate` の指摘を、あなたが見るより先にエージェントへ返すハーネス。
- Dockerfile。

## よくあるつまずき

- **`bunx create-guren-app` が質問してきた。** 4 つのフラグのどれかが抜けているか綴りが違います。上のコマンドはすべて指定しています。非対話シェルで `--git` を省くとリポジトリは作られず、この章のコミットが「not a git repository」で失敗します。
- **`git commit` が「Please tell me who you are」で失敗する。** `git config user.name` と `git config user.email` を一度設定して、コミットをやり直してください。
- **手順 6 で何も変えていないのに `bun test` が通る。** 赤のステップを走らせる前に `Home.tsx` を置き換えています。順序が大事です。テストが先、失敗を見届けて、それから変更です。
- **エージェントの `Stop` hook が走らなかった。** 走るのはツリーに未コミットの変更があるときだけです。ターンを終える前にコミットするエージェントは hook にゲートされません。だからこの章では、コミットの前に自分で `bunx guren gate` を実行しています。
- **ポート 3333 が使用中。** 開発サーバーは次の空きポートへ進み、実際に束縛したポートを表示します。決めつけずに起動時の表示を読んでください。

## 次へ

第 2 章「リクエストをひとつ、手で」(準備中)では、空のファイルからルート、コントローラー、ページをテストを先に置いて組み上げ、2 つ目のページをエージェントに委ねます。

# CLI リファレンス

Guren には CLI が 2 つ付いています。

- `bunx guren`: 既存のプロジェクトの中で、コントローラー・モデル・ビューの生成や各種ユーティリティを実行する
- `bunx create-guren-app`: 新しいアプリの雛形を作る

## 基本的な使い方

```bash
# グローバルインストール不要。プロジェクトルートでそのまま実行
bunx guren --help
```

コマンドは `bunx guren make:controller UserController` のように、サブコマンドの形で指定します。

## 高レベルスキャフォールド

`bunx guren add <feature>` は、スターターアプリと同じ形で機能を追加します。必要なプロバイダー、設定、ランタイムのファイルを生成し、それを使うように `src/app.ts` を書き換えます。個々のファイルを作る `make:*` より先に、こちらを検討してください。

```bash
bunx guren add auth
bunx guren add admin
bunx guren add resource posts --fields "title:string,body:text"
bunx guren add queue
bunx guren add mail
bunx guren add events
bunx guren add cache
bunx guren add notifications
bunx guren add storage
bunx guren add attachments
bunx guren add session
bunx guren add broadcasting
bunx guren add schedule
bunx guren add lint
bunx guren add prototype
bunx guren add ai --provider anthropic
bunx guren add oauth
bunx guren add browser-tests
```

まず `bunx guren add auth` と `bunx guren add resource` から始め、アプリが育つのに合わせてほかの機能を足していってください。

### プラグインのインストール

```bash
bunx guren plugin @acme/guren-plugin-audit
```

`plugin`(`add plugin` とも書けます)を実行すると、まず依存がまだ入っていなければ `bun add` でインストールします(`--no-install` で省略できます)。次に、プラグインが宣言している Guren のバージョン互換性を確かめ(`--ignore-compatibility` で無視できます)、Provider を `src/app.ts` に登録します。プラグインが `gurenPlugin` マニフェストで宣言した設定スタブや環境変数のキーも反映します。公開済みのファイルを上書きしたいときは `--force` を付けます。

### `add admin`

`bunx guren add admin` を実行すると、次のファイルができます。

- `app/Http/Controllers/Admin/AdminDashboardController.ts`
- `resources/js/pages/admin/Dashboard.tsx`
- `routes/admin.ts`(`routes/web.ts` がある場合は自動配線)

ダッシュボードは**デフォルトでログインが必要**です。`routes/admin.ts` が `/admin` に `requireAuthenticated({ redirectTo: '/login' })` を付け、コントローラーでも `this.auth.userOrFail()` を呼びます。`make:feature --public` は更新系のアクションだけを公開しますが、こちらの `--public` はダッシュボード全体を公開します。

```bash
bunx guren add admin --public
```

`add auth` より先に `add admin` を実行してもかまいません。その場合もガードは効いていますが、認証を入れていないアプリにはサインインしたユーザーがいないので、すべてのリクエストが `/login` にリダイレクトされます。`/login` は `bunx guren add auth` を実行して初めてできるルートです。実際に使えるダッシュボードにしたいなら、先に認証を追加するか、`--public` を付けてあとから独自のチェックを書いてください。

### `add resource`

`add resource` は、パッチを当てる 2 つのファイルがそろっていることを求めます。テーブル定義を `db/schema.ts` に追記し、CRUD ルートを `routes/web.ts` に登録するので、どちらもあらかじめ存在していなければなりません。さらに、対象のルートがまだ登録されていない場合は、`routes/web.ts` がパッチを当てられるルートレジストラを export している必要があります。

どれかが欠けていると、コマンドは足りないものを示して、何も生成しません。生成したファイルだけが残り、登録されないルートのためのテーブルが `db/schema.ts` に追記された状態になるのを避けるためです。

2 つのパッチなしでファイルだけ欲しい場合は、`bunx guren make:feature` を使ってください。貼り付け用のルートのブロックを表示し、テーブル定義を追記するスキーマファイルも教えてくれます。

### `add prototype`

`add prototype` は、プロトタイプモード([プロトタイプファースト](./prototype-first.md))を導入するコマンドです。実行すると、シードデータで Inertia の visit に応答する `resources/js/prototype/` の fixture、`dev:prototype` と `build:prototype` のスクリプト、`resources/js/app.tsx` と `src/app.ts` に入るローダー 2 行が追加されます。`--remove` を付けると、スクリプトとローダーを取り除きます。

続けて `make:feature <Entity> --fields "…" --prototype` を実行すると、機能のうち画面に見える部分(ページ、バリデーター、ページデータ型、fixture のエントリ)を書き出し、`prototype` ハンドラーで登録するルートを表示します。

ページデータ型（`resources/js/types/<Entity>.ts`）ができたあとで、同じコマンドをフラグなしで実行すると昇格になります。モデル、Resource、コントローラーが書き出され、Resource はページデータ型に合わせて型付けされます。ページとバリデーターには手を付けません。

`bun run build:prototype` は Vite の前に `check --prototype` を実行するので、fixture にエントリがないルートは、顧客がクリックしたときではなくビルドの時点で失敗します。

### `add ai`

`add ai` は、`@guren/plugin-ai` を使ったインプロセスの AI エージェントを導入します。プロバイダを 1 つ(`--provider anthropic`、`openai`、`gateway` のいずれか)選ぶと、そのプロバイダ用の `config/ai.ts` を書き出し、API キーを `config/env.ts` と env ファイルに宣言し、設定と `aiPlugin()` を `createApp()` に登録します。そのあとプラグイン、`ai`、プロバイダーのパッケージ（`gateway` では不要）を `bun add` します。`--no-install` を付けると、実行するコマンドを表示するだけになります。

キーは任意なので、設定していなくてもアプリは起動し、最初のプロンプトを送った時点で失敗します。

このコマンドを使うには `config/env.ts` が必要です。`db/schema.ts` があるアプリでは、`ai_conversations` と `ai_messages` の 2 つのテーブルを追加してマイグレーションを生成し、会話をそこに保存するよう `config/ai.ts` を設定します。`--no-conversations` を付けると、この処理を省きます。テーブルには、ツールの結果も含めてモデルが見た会話がそのまま残るので、機密データとして扱ってください。

エージェントクラスは、そのあと `make:ai-agent <Name>` で `app/Ai/Agents` に書き出します。`--tools` に指定したエージェントツールは、ルートから導出できることを確かめたうえでエージェントに渡されます。`--output` を付けると構造化出力のスキーマの雛形が加わり、`--test` を付けると `app.fakeAi()` でモデルの応答を台本にしたテストが書き出されます。スコープ、会話、ストリーミング、キューについては [AI エージェント](./ai-agents.md) で説明しています。

### `add lint`

lint の設定は、`create-guren-app` 1.12 以降で作ったアプリには最初から入っています。`add lint` はそれより前に作ったアプリ向けのコマンドで、アプリのコードには手を付けません。

実行すると `.oxlintrc.json` を書き出します。中身は `@guren/cli/oxlint` の Guren ルールを入れた oxlint の設定で、`guren/await-async-assertion` は error、`app/`・`config/`・`routes/`・`src/`・`modules/` に対する `guren/no-unvalidated-env-read` は error、`resources/css/guren.css` があるアプリでは `resources/js/` に対する `guren/no-raw-color` も error、`guren/comment-*` は warn です。あわせて `lint` / `lint:fix` スクリプトを追加し、`oxlint` を `~` レンジで devDependency に加えます。oxlint の JS プラグイン API はまだ alpha なので、パッチ更新だけを受け入れるようにしています。

実行したら `bun install` してください。`bunx oxlint` は Bun 上で動くので、Node は要りません。`config/env.ts` が導入される前に作ったアプリでは、自前の `config/database.ts` や `src/app.ts` にある `process.env` の読み取りも、スキーマに移すか無効化のコメントを付けるまで、このルールに報告されます。

### `add browser-tests`

`add browser-tests` は、Playwright のブラウザテストを導入します。テストはアプリを `bunx guren browser:serve` 経由で起動するので、本番環境や、ローカルだと確かめられないデータベースでは起動しません。このコマンドは `playwright.browser.config.ts`(アプリを `127.0.0.1:4317` で起動する設定)と `tests/browser/support.ts` を書き出してから `bunx guren browser:map` を実行します。以後は `browser:map` が、`tests/browser/generated/` の下に次の 2 種類の spec を保ちます。

- `smoke.browser.ts`: ブラウザマップの機能ごとに 1 つのテストで、パスパラメーターのない最初のページが 200 を返し、ルートが描画するはずのコンポーネントを表示することを確かめます
- `plans/<plan>.browser.ts`: ビューを持つ承認済みの計画ごとに 1 つのファイルで、計画がビューに定めたフォームのラベルとアクション名が、そのビューを描画するパスパラメーターのない最初のページに表示されることを確かめます

開けないページ(どのルートもパラメーターを取る、まだ描画するルートがない、アプリが用意できないサインイン済みのユーザーが要る)は、理由を書いた `test.fixme` になります。結果ではスキップとして表示され、合格にはなりません。計画を承認したら `bunx guren browser:map` をもう一度実行してください。生成した spec が古いあいだ、`--check` は終了コード 1 を返します。どの機能や計画からも生成されなくなった spec は削除されます。生成ヘッダーのないファイルが `tests/browser/generated/` にあると上書きを拒むので、自分で書く spec はこのディレクトリの外に置いてください。

パスワードでサインインするアプリ(`make:auth` が書き出す `users` テーブルと `POST /login` ルートがあるアプリ)では、セットアッププロジェクトの `tests/browser/auth.setup.ts` と、シーダーの `db/seeders/browser-account.ts` も書き出します。シーダーは `browser:serve` がアプリを起動したときに `BROWSER_TEST_PASSWORD` のパスワードで `browser@example.test` を作り、それ以外の起動や本番環境では何もしません。初回の実行までに `.env` の `BROWSER_TEST_PASSWORD` を設定してください。シーダーは起動時のシードで動くので、`config/database.ts` で `defineDatabaseConfig()` に `seedOnBoot` を渡しておく必要があります。渡していなければ、コマンドが警告します。

あわせて `test:browser` スクリプト(`playwright test -c playwright.browser.config.ts`)を追加し、`@playwright/test` を devDependency に加えます。`--no-install` を付けると、`bun add` のコマンドを表示するだけになります。`test-results/`、`playwright-report/`、`tests/browser/.auth/` は `.gitignore` に追加されます。別のコマンドを実行する `test:browser` スクリプトがすでにあれば、何も書かずに中断します(`--force` で置き換えます)。`bunx playwright install chromium` でブラウザを入れてから、`bun run test:browser` で実行します。Playwright は Node 上で動くので、`PATH` に Node 20.12 以降が必要です。

`bun test` は `*.spec.ts` も集めてしまうため、spec のファイル名は `.browser.ts` で終わります。ブラウザテストは `guren gate` では実行されません。

### API 専用アプリの場合

`api` ブループリントで作ったアプリには、`@guren/inertia-client` への依存も、web ルートのエントリ（`routes/web.ts` / `routes/web.js`）もありません。Inertia のページを書き出すコマンドは、この 2 つの手がかりを見て次のように動きます。

| コマンド | API 専用アプリでの動き |
|----------|------------------------|
| `add admin` | 中断し、何も生成しない。管理用のエンドポイントは `make:controller` で生成し、`routes/api.ts` に登録する |
| `add auth`、`make:auth` | `db/schema.ts` へのパッチやマイグレーションの生成より前に中断する。トークンベースの API なら、`createBearerTokenMiddleware` で `routes/api.ts` を保護し、`createApiToken` でトークンを発行する（[API トークンガイド](./api-tokens.md)を参照） |
| `add resource`、`make:feature` | テーブルを追記する前に中断する。JSON を返すコントローラーを `make:controller` で生成し、`routes/api.ts` につなぐ |
| `make:view` | 中断する。ページには代わりになる JSON の形がない |
| `add prototype` | 中断する。プロトタイプモードは Inertia の visit に応答するもの |
| `add browser-tests` | 中断する。spec は Inertia のページを操作するので、ルートは `TestApp` を使って HTTP でテストする |
| `make:controller` | 合わせて生成する。`this.json(...)` を返すコントローラーになり、そのまま `routes/api.ts` につなげる |

手がかりから API 専用だと確認できなければ、どのコマンドもフルスタックのアプリと同じように動きます。`@guren/inertia-client` をインストールすれば、通常の動きに戻ります。`guren codegen` は、API 専用アプリではページコンポーネントを `.guren/pages.gen.ts` から外します。このファイルが `@guren/inertia-client` を import するためで、`make:view` の中断は、それを原因となったコマンドの時点で知らせるためのものです。

### 既存のファイルがある場合

`add resource` と `make:feature` は、最初のファイルを書く前に、書き出す予定のファイルをすべて確認します。手書きのモデルなど、すでにあるファイルが見つかれば、該当するものをすべて一覧にして中断し、何も書き込みません。`add resource` の場合は、`db/schema.ts` と `routes/web.ts` も変更しません。

`--force` を付けると、一覧のファイルは手書きのものも含めてすべて上書きされます。`--test`・`--factory`・`--policy` を付けたときだけ追加されるファイルには、一覧にそのフラグが添えてあり、フラグを外せば衝突を避けられます。プロトタイプからの昇格では、プロトタイプのときに書いたページとバリデーターをそのまま残すので、これらは既存のファイルとして数えません。

複数のファイルを書き出すほかのコマンドも、最初に書き込む前に同じ確認をして中断します。対象は `make:auth`、`make:module`、`make:ai-agent`(`--test` がフラグにあたります)、`deploy`、そして `add` の各ブループリントで、サンプルのイベント・ジョブ・Mailable も含みます。ファイルを 1 つだけ書く `make:*` コマンドも、同じメッセージで中断します。例外は、途中まで入ったものを再実行で補うためのブループリント(`add session`、`add cache`、`add schedule`、`add ai`、`add prototype`)で、既存のファイルは残し、足りないものだけを書き出します。

## 主要コマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `key:generate` | 新しい `APP_KEY` 値を生成。`--write` で `.env` に保存 | `bunx guren key:generate --write` |
| `deploy` | Docker/Fly.io/Railway 向けデプロイ設定ファイル、または Cloudflare へのデプロイ用ワークフローを生成 | `bunx guren deploy --target all --app my-app --port 3333` |
| `make:controller <Name>` | `app/Http/Controllers` にコントローラーを生成(API専用アプリでは Inertia ページの代わりに JSON を返す) | `bunx guren make:controller PostController` |
| `make:model <Name>` | 最小のモデルクラスと型定義を `app/Models` に生成(`db/schema` から `camelCase(Name)s` を import) | `bunx guren make:model Post` |
| `make:view <path>` | `resources/js/pages` に React コンポーネントを生成(API専用アプリでは中断) | `bunx guren make:view posts/Index` |
| `make:auth` | ログイン/ログアウト・新規登録・パスワードリセットのコントローラー、プロバイダー、ビュー、マイグレーション、シーダー、ルートをスキャフォールド(`--minimal` で登録・パスワードリセットを省略、`--verify` でメール確認も追加、`--oauth <providers>` でカンマ区切りのプロバイダー向け OAuth ログインボタンも追加、`--oauth-only` でパスワードログインを完全に外して OAuth のみにする) | `bunx guren make:auth --oauth github,google` |
| `make:middleware <Name>` | `app/Http/Middleware` にミドルウェアを生成 | `bunx guren make:middleware Auth` |
| `make:seeder <Name>` | データベースシーダーファイルを生成 | `bunx guren make:seeder UserSeeder` |
| `make:job <Name>` | キュー可能なジョブクラスを生成（`jobName` はクラス名で固定） | `bunx guren make:job SendEmail` |
| `make:event <Name>` | イベントクラスを生成 | `bunx guren make:event UserRegistered` |
| `make:listener <Name>` | イベントリスナークラスを生成 | `bunx guren make:listener SendWelcomeEmail` |
| `make:notification <Name>` | 通知クラスを生成（`type` はクラス名で固定） | `bunx guren make:notification InvoicePaid` |
| `make:mail <Name>` | メールクラスを生成 | `bunx guren make:mail WelcomeEmail` |
| `make:command <Name>` | `app/Console/Commands` にコンソールコマンドを生成。`--command <name>` で呼び出し名を指定。`src/console.ts` への登録が必要([コンソールコマンドガイド](./console.md)参照) | `bunx guren make:command SendDigest --command reports:digest` |
| `make:policy <Name>` | 所有者ベースのデフォルトを備えた認可ポリシーを `app/Policies` に生成 | `bunx guren make:policy Post` |
| `make:ai-agent <Name>` | インプロセスの AI エージェント(`@guren/plugin-ai`)を `app/Ai/Agents` に生成する。`--tools` はルート由来のエージェントツールを付与し、`--output` は Zod の出力スキーマを加え、`--test` は `fakeAi()` のテストを書く | `bunx guren make:ai-agent SupportTriager --tools tickets_show --test` |
| `make:agent <Name>` | 永続エージェントを `app/Agents` に生成し、`config/agents.ts` に登録し、モデルや ORM から遠ざける `guren.arch.ts` のルールを追加し、クラスが必要とする `config/bindings.ts` と tsconfig の `types` エントリも書き出す([永続エージェント](./durable-agents.md)参照) | `bunx guren make:agent Triager` |
| `make:validator <Name>` | Zodバリデーションスキーマ(ルートパラメータ・一覧クエリ・ペイロード)を `app/Http/Validators` に生成。`--fields` は `make:feature` と同じ構文 | `bunx guren make:validator Post --fields "title:string,body:text"` |
| `make:adr "<Title>"` | アーキテクチャ意思決定を採番付きファイルとして `docs/adr/` に記録(リンク可能なfrontmatter付き)。`--entity <Model>` で `entities:`/`related:` を自動補完、`--issue <ref>`(カンマ区切りで複数可)でGitHubのIssue/PRへの `issues:` リンクを記入 | `bunx guren make:adr "Billing cycle is end-of-month" --entity Invoice --issue 412` |

> **Note:** `make:*` は既存ファイルを上書きしません。必要なら `--force` を付けてください。

## 検査・監査コマンド

リリース前にアプリを検証するためのコマンドです。AI コーディングエージェントから使うことも想定していて、`--json` を付けると機械で読める形式で出力します。

これらのコマンドの裏にある規則と、誤検出の抑制方法は[チェックと監査の詳細](./cli-checks.md)で説明しています。

| コマンド | 説明 | 例 |
|---------|------|-----|
| `check` | アプリの配線を検証する（対象の一覧は表の後ろ） | `bunx guren check --json` |
| `audit` | セキュリティ監査。更新系ルートでのバリデーション・認証・Policy による認可の抜け、文字列を埋め込んだ生 SQL、ハードコードされた認証情報、無効にされたセキュリティのデフォルト設定、mass assignment の設定、`hidden` に入っていない機微なカラム、リクエストのホストから組み立てたメール内のリンク、アプリやインストール済みパッケージが宣言した CSRF の除外、インプロセスエージェントのローカルツールを調べる | `bunx guren audit --json` |
| `gate` | 雛形に含まれる CI が実行する検証ステージ(codegen・typecheck・lint・`--ci` の規則での `check`・`audit`・テスト)をまとめて実行し、どれかが失敗すれば非ゼロで終了する。実行できないステージは、スキップではなく失敗として扱う | `bunx guren gate --changed` |
| `introspect` | boot も listen もせずにアプリの provider とルートを登録し、マニフェストを出力する。マニフェストには、provider ごとの登録結果、解決済みのミドルウェアとコントローラのファイルを含むルート、session・auth・cache・storage・queue・attachments の設定、データベースがローカルかどうか(接続文字列そのものは含まない)が入る | `bunx guren introspect --json` |
| `doctor` | プロジェクトの健全性(環境変数・設定・生成ファイル)のレポートと、次にやるべきこと | `bunx guren doctor --next` |
| `context [Entity]` | プロジェクトのコンテキストマップ。エンティティ名を渡すと、1 つのモデルに関するものをすべて出力する。対象は、テーブル、リレーション、`fillable`/`hidden`/`visible`/`casts`、スキーマ付きのルート(`<Entity>Controller`、モデルを指す `bind`、モデルを使うアクション本体のどれかで対応付ける)、Props 付きのページ、Resource、Policy、紐付いた docs と Issue。同名のモデルは `--module` で区別し、`"app"` はプロジェクトルートを指す。`--live` を付けると `gh` に Issue の状態を問い合わせ、`--repo owner/name` で origin リモートの代わりのリポジトリを指定できる | `bunx guren context User --json` |
| `docs:graph` | OKF docs のリレーショングラフ。文書・エンティティ・コードパスがノードで、検証済みのリレーションがエッジになる。`--entity <Model>` / `--path <file>` で周辺だけに絞れるので、リネームの前に「これを規定している docs はどれか」を調べられる | `bunx guren docs:graph --path app/Http/Controllers/PostController.ts` |
| `spec:generate` | `docs/spec/` にある導出スペックビュー(ER 図・ドメインモデル・画面一覧・モジュールマップ)を生成し直す。詳しくは[スペックアンカード開発](./spec-anchored.md)を参照 | `bunx guren spec:generate` |

`audit` は、名前付きミドルウェアで保護したルート(例: `router.middleware('auth').group(...)`)を保護済みとして扱い、`/login` や `/register` などのゲスト向けのフローを認証チェックの対象から外します。

### `check` の検証対象

`check` が検証するのは次のものです。

- ルート、コントローラー、ページ、モデルが互いに食い違っていないこと
- `routes/` 配下の各ファイルがエントリのレジストラから、モジュールの `routes/` 配下が各モジュール自身のレジストラから実際に呼ばれていること
- `config/agents.ts` の永続エージェントレジストリと、インプロセスエージェントの `appTools()` の名前とスコープ
- deferred props: ページの `Props` が必須として宣言している prop に `defer()` を渡していないか（参考扱いの警告）
- doc リンク、スペックビューが最新か、アーキテクチャ境界
- デプロイ用プラグインか Lambda アダプターを宣言しているアプリでは、`guren doctor` が報告するデプロイ実行環境の判定（参考扱い）

### 終了コードとスイートのフラグ

`audit` は失敗(fail)を見つけると非ゼロの終了コードを返します。フラグなしの `check` は報告するだけですが、スイートを選ぶフラグを付けると、そのスイートに失敗があったときに非ゼロで終了します。雛形に含まれる CI ワークフローは、後で説明する `gate` を実行します。

```bash
bunx guren audit
bunx guren check --arch    # アーキテクチャ境界(guren.arch.ts + モジュールルール)
bunx guren check --docs    # docリンク: OKF frontmatter(type/entities/related)+ 本文リンク + @docsタグ
bunx guren check --spec    # docs/spec/ が再生成結果と一致するか
bunx guren check --prototype  # prototype ハンドラーのルートに名前付きの fixture エントリがあり、ローダーが配線されているか
```

スイートのフラグを複数付けると、それぞれのスイートをすべて実行します。`--changed` を付けると、どのスイートも main とのマージベースから変更されたファイルだけを対象にします。[エージェントハーネス](./agent-harness.md#hooks)が編集のたびに走らせる hook は、この速い経路を使っています。

### `--fix` で生成し直す

指摘の中には、ファイルを生成し直せば消えるものもあります。`.guren/*.gen.ts` マニフェストがない場合(`guren codegen`)と、`docs/spec/` のビューが古い場合(`guren spec:generate`)です。`check --json` は、こうした指摘に `fix` フィールドを付けます。中身は `{ "kind": "command", "args": ["codegen"] }` のような、`guren` に続く引数です。

`--fix` を付けると、重複を除いた fix を 1 回ずつ実行してからもう一度チェックし、2 回目の結果を報告します。実行したコマンドは `fixes` に入ります。どれかのコマンドが失敗したときや、コマンドは成功したのに消えるはずの指摘が残ったときは、非ゼロで終了します。

`--ci` と `--fix` は同時に指定できません。ゲートが古いファイルを自分で生成し直すと、いつでも通ってしまうからです。`--fix` は手元で実行し、書き換わったファイルをコミットしてください。コードの修正や判断が必要な指摘には `fix` が付かず、`suggestion` の文章だけが付きます。

```bash
bunx guren check --fix          # 指摘が示すファイルを再生成して、もう一度チェック
bunx guren check --spec --fix   # 同じことをスペックビューに限って行う
```

`doctor --fix` はdoctorが指摘した不足・古い生成ファイルを再生成し、別のプロセスでもう一度doctorを実行します。`routes/api.ts` を含むアプリのルートエントリを選び、同じ生成コマンドは1回だけ実行します。

`doctor --json` では実行可能な修復を `repair: { kind: 'command', args }` として返し、`--fix` を付けた結果には実行記録の `fixes` も入ります。生成コマンドが失敗した場合、再確認で修復対象の指摘が解消しなかった場合、再確認自体ができなかった場合は非ゼロで終了します。ほかの警告はレポートに残り、`--strict` を付けると警告・失敗も終了コードに反映します。

`canAutofix` が示す設定の自動修正は引き続き `guren upgrade` の対象です。このフラグは生成ファイルだけを書き換えます。

```bash
bunx guren doctor --fix --next
bunx guren doctor --fix --json
```

### `gate`

`gate` は、「この変更は終わったか」に 1 つの終了コードで答えるコマンドです。雛形に含まれる CI ワークフローが実行するステージ、つまり codegen、typecheck、lint(アプリに `.oxlintrc.json` がある場合)、`--ci` の規則での `check`、`audit`、テストスイートをすべて実行し、ステージごとに結果を報告して、どれかが失敗すれば非ゼロで終了します。

実行*できない*ステージは、スキップではなく失敗として扱います。たとえば、`.oxlintrc.json` があるのに oxlint が入っていない、`typecheck` スクリプトがない、routes のエントリが読み込めない、といった場合です。lint をスキップするのは、`.oxlintrc.json` がないアプリだけです。

`check` と `audit` のステージは、イントロスペクションの結果を読みます。イントロスペクションでは、アプリを起動しない子プロセスで provider とルートを登録します([イントロスペクションの結果を読むチェック](./cli-checks.md#イントロスペクションの結果を読むチェック)参照)。1 回の実行につき 1 回(上限 10 秒)で、codegen のあとに行うので、clone したばかりのアプリでもエントリを import できます。

次の 2 種類の結果は、ゲートを失敗にしない[参考扱い](./glossary.md#計画の状態)の行として表示します。

- イントロスペクションが失敗すると、それを必要としたステージに 1 行加えます。
- `-unverified` の結果(アプリでしか判定できず、イントロスペクションでも確かめられなかったもの)は、理由を添えて check ステージに表示します。ソースを変更していない `--changed` の実行ではイントロスペクションを行わないので、この行は出ません。

`guren plan:verify` も、check のステップで同じ行を表示します。

```bash
bunx guren gate            # 全ステージをフルで
bunx guren gate --changed  # check と lint を変更ファイルに限定(typecheck・audit・テストはフルのまま)
bunx guren gate --deps     # audit ステージに依存関係スキャンを追加
bunx guren gate --json     # ステージごとのレポート(ツール向け)
```

雛形に含まれる `.github/workflows/ci.yml` は `bunx guren gate --deps` の 1 ステップだけなので、手元でゲートを通した変更は CI でも通ります。エージェントハーネスは、Claude Code、Codex、Cursor のターンが終わるときにこのコマンドを実行し([エージェントハーネス](./agent-harness.md#hooks)参照)、MCP サーバは `guren_gate` ツールとして公開しています。`AGENTS.md` を読むエージェントには、作業を終える前に実行するよう指示しています。

これらのコマンドの詳細は[チェックと監査の詳細](./cli-checks.md)にあります。`audit` の [Policy ルール](./cli-checks.md#audit-の-policy-ルール)、[`introspect`](./cli-checks.md#登録済みアプリのイントロスペクション) が実行するもの、[エージェントに公開したルート](./cli-checks.md#エージェントに公開したルート)と[インプロセスエージェント](./cli-checks.md#インプロセスエージェント)に追加される規則、[`audit` の指摘の抑制](./cli-checks.md#audit-の指摘を抑制する)、[アーキテクチャ境界](./cli-checks.md#アーキテクチャ境界)、[チェックがアプリを読む仕組み](./cli-checks.md#チェックがアプリを読む仕組み)です。

## アプリケーションモジュール

ルートが数十を超えてきたら、フラットな `app/`・`routes/`・`db/schema.ts` にすべてを詰め込むのをやめて、`guren make:module` でアプリの一部を独立したモジュールとして切り出せます。

```bash
bunx guren make:module Billing
```

`modules/billing/{index.ts, routes.ts, db/schema.ts}` が生成され、配線も自動で済みます。`db/schema.ts` には `export * from '../modules/billing/db/schema'` が、`src/app.ts` には `billingModule` の import と `createApp({ modules: [...] })` への登録が追加されます。

ルートの `db/schema.ts` が、drizzle に渡すスキーマオブジェクト(`export const schema = { posts, users }` のように、名前が `schema` であるか `typeof` で参照されているもの)を持っていることがあります。その場合はモジュール側にも `export const billingSchema = {}` が生成され、ルートのオブジェクトがそれを展開します(`{ posts, users, ...billingSchema }`)。モジュールのテーブルは `modules/billing/db/schema.ts` に宣言し、1 つずつ `billingSchema` に並べてください。

どちらかのオブジェクトからテーブルが抜けていると、`guren check` が報告します。ルートのオブジェクトが並べても展開もしていないモジュールのテーブルも、報告の対象です。

ほとんどの `make:*` コマンドは `--module <name>` を受け付け、プロジェクトルートではなくモジュールの中に雛形を生成できます。

```bash
bunx guren make:controller Invoice --module billing   # modules/billing/app/Http/Controllers/InvoiceController.ts
bunx guren make:model Invoice --module billing        # modules/billing/app/Models/Invoice.ts
```

`guren check`・`guren audit`・`guren context`・`model:list`・`doctor` は、どれも `modules/*/` を自動でスキャンするので、設定を足す必要はありません。例外は 2 つあります。1 つは `make:auth` で、認証はモジュールごとではなくアプリ全体で扱うものだからです。もう 1 つは `make:migration` で、drizzle-kit が `drizzle.config.ts` の指すスキーマのパスからマイグレーションを生成するので、モジュールがあってもなくても同じように動きます。

モジュールの公開 API は、`defineModule()` の記述を export する `index.ts` と、モジュール間で共有するテーブル定義を置く `db/schema.ts` の 2 つです。`modules/` ディレクトリがあれば、`guren.arch.ts` がなくても `guren check` がこの境界を自動で守らせます。あるモジュールが別のモジュールの内部(`index.ts` と `db/schema.ts` 以外)に踏み込んで import すると失敗になり、トップレベルのアプリのコードが同じことをした場合も失敗になります。

```typescript
// modules/billing/index.ts
import { defineModule } from '@guren/core'
import { registerBillingRoutes } from './routes'

export const billingModule = defineModule({
  name: 'billing',
  prefix: '/billing',            // レジストラが宣言する全ルートに付与する任意のURLプレフィックス
  routes: registerBillingRoutes,
  providers: [BillingServiceProvider],  // 任意 — アプリのプロバイダ一覧に追加される
})
```

そのモジュールだけが使うサービスの config 定義も、モジュールに持たせられます。`modules/<name>/config/` に置き、`defineModule({ config: [...] })` に並べてください。これらの定義はアプリの `createApp({ config })` のあとにバインドされ、同じキー空間を使います。そのため、同じキーを両方で定義すると起動に失敗します([設定](./configuration.md#モジュールが持つ定義)を参照)。`guren check` は、`createApp({ modules })` に並んでいるモジュールについて、この配列を配線として読みます。

Inertia のページは、`modules/<name>/` の下には置きません。トップレベルの `resources/js/pages/` に置いたまま、モジュール名のディレクトリで分けます(`resources/js/pages/billing/Invoices/Index.tsx`)。`make:feature Invoice --module billing` は、この規約に自動で従います。

## AIエージェントハーネス

`create-guren-app` で作ったアプリには、エージェントハーネスが入っています。Claude Code、Codex、Cursor、GitHub Copilot、OpenCode 向けのプロジェクトガイド、ルール、スキル、MCP の設定と、対応しているエージェント向けの hooks です。エージェントごとに入るファイルと hooks の動きは[エージェントハーネス](./agent-harness.md)で説明しています。

| コマンド | 説明 | 例 |
|---------|------|-----|
| `agent:init` | 選んだエージェント向けのハーネスを既存のアプリに入れる（既存のファイルはスキップ。`--force` で上書き） | `bunx guren agent:init --target codex,cursor` |
| `agent:sync` | ディスク上で見つかったすべてのエージェントについて、フレームワークが管理するファイル（ルール、スキル、サブエージェント、hook）を更新する | `bunx guren agent:sync` |

## デプロイレシピ生成

デプロイ用の設定ファイルは、CLI から直接生成できます。

```bash
# Dockerfile のみ
bunx guren deploy

# Fly.io（Dockerfile + fly.toml）
bunx guren deploy --target fly --app my-app

# Railway（Dockerfile + railway.json）
bunx guren deploy --target railway

# すべてのレシピを一括生成（カスタムポート）
bunx guren deploy --target all --app my-app --port 4000
```

`--target cloudflare` を指定すると、`cloudflare:deploy` を 1 回ずつ実行する GitHub Actions のワークフロー（`.github/workflows/deploy-cloudflare.yml`）を書き出します。使うには [cf CLI の準備](./cloudflare.md#cf-cli-でのデプロイベータ)と、リポジトリの secrets に `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` が必要です。

`--target` には `docker` / `fly` / `railway` / `cloudflare` / `all` を指定できます（`all` は最初の 3 つです）。書き出すファイルがすでにあると、コマンドは該当するファイルをすべて一覧にして、1 つも書き込みません。上書きしたいときは `--force` を付けてください。

Vercel と AWS Lambda には、プラグインを使います。Vercel は `bunx guren plugin @guren/plugin-vercel`、AWS Lambda は `bunx guren plugin @guren/plugin-lambda` で導入します。`--target vercel` を指定するとエラーになります。どちらの手順も[デプロイ](./deployment.md)で説明しています。

## OpenAPI コマンド

| コマンド | 説明 | 例 |
|---------|------|-----|
| `openapi:generate` | ルート定義から OpenAPI 3.1 ドキュメントを生成 | `bunx guren openapi:generate` |

使うには、別途 `@guren/openapi` パッケージを入れる必要があります(`bun add @guren/openapi`)。

### openapi:generate オプション

```bash
# デフォルトで生成（routes/web.ts を読み取り、.guren/openapi.gen.json に書き出し）
bunx guren openapi:generate

# タイトル、バージョン、説明を指定
bunx guren openapi:generate --title "Blog API" --version "1.0.0" --description "My blog"

# ルートファイルと出力パスを変更
bunx guren openapi:generate --routes routes/api.ts --out docs/openapi.json

# サーバー URL を含める
bunx guren openapi:generate --server "https://api.example.com"

# 既存ファイルを上書き
bunx guren openapi:generate --force
```

| フラグ | デフォルト | 説明 |
|-------|----------|------|
| `--routes` | `routes/web.ts` | ルート登録ファイルのパス |
| `--out` | `.guren/openapi.gen.json` | 生成ドキュメントの出力パス |
| `--title` | `package.json` の name または `"Guren API"` | OpenAPI ドキュメントタイトル |
| `--version` | `package.json` の version または `"1.0.0"` | OpenAPI ドキュメントバージョン |
| `--description` | `package.json` の description | OpenAPI ドキュメント説明 |
| `--server` | — | 含めるサーバー URL |
| `--app` | カレントディレクトリ | アプリケーションルートディレクトリ |
| `--force` | `false` | 既存ファイルを上書き |

このコマンドは、ルートコントラクトから Zod スキーマと OpenAPI のメタデータ(`summary`、`description`、`tags`、`operationId`、`deprecated`)を取り出して、OpenAPI 3.1 の JSON ドキュメントを生成します。ルートへの注釈の付け方は、[ルーティング: OpenAPI](./routing.md#openapi-ドキュメント生成)を参照してください。

## ルートコマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `route:list` | 登録済み全ルートを一覧表示 | `bunx guren route:list` |

### route:list オプション

アプリのルートをすべて表示します。絞り込みや並べ替えもできます。

```bash
# 全ルートを一覧表示
bunx guren route:list

# HTTPメソッドでフィルタリング
bunx guren route:list --method GET

# パスパターンでフィルタリング
bunx guren route:list --path users

# ルート名でフィルタリング
bunx guren route:list --name admin

# ルートをソート
bunx guren route:list --sort path
bunx guren route:list --sort method
bunx guren route:list --sort name

# ソート順を逆にする
bunx guren route:list --sort path --reverse

# 出力フォーマット
bunx guren route:list --format table   # デフォルトのテーブル形式
bunx guren route:list --format json    # JSON出力
bunx guren route:list --format compact # コンパクトな1行形式
```

## エージェントツールコマンド

`.agent()` メタデータを宣言したルートは、MCP ツールとして AI エージェントに公開されます([ルーティング](./routing.md)を参照)。ここで紹介するコマンドは、エージェントから何が見えるかを、ルートグラフから直接導出して表示します。`.guren/agents.gen.ts` は読まないので、このマニフェストがなかったり古かったりしても、正しい結果を返します。

| コマンド | 説明 | 例 |
|----------|------|----|
| `tool:list` | このアプリが公開しているエージェントツールを一覧表示 | `bunx guren tool:list` |
| `tool:inspect` | 1 つのツールの導出結果を表示 | `bunx guren tool:inspect posts.store` |
| `tool:call` | エージェントと同じ経路で 1 つのツールを呼び出す | `bunx guren tool:call posts.index` |
| `tool:dev` | 使い捨てトークン付きでツールをローカルに提供 | `bunx guren tool:dev` |
| `tool:log` | エージェント監査ログを読む | `bunx guren tool:log --tail` |

```bash
# 公開中の全ツールを、メソッド・パス・プロトコル別の公開状態・
# 認可アビリティ・MCPアノテーションとともに表示
bunx guren tool:list

# 導出結果そのもの（警告を含む）
bunx guren tool:list --json

# 1つのツールの詳細: 入力フィールド・出力スキーマ・認可・
# アノテーション・承認・マスク対象
bunx guren tool:inspect posts.store
bunx guren tool:inspect posts.store --json

# アプリの MCP エンドポイントをローカルで起動し、コマンドの生存期間だけ
# 有効なトークンと、MCP Inspector の接続コマンドを表示する
bunx guren tool:dev
bunx guren tool:dev --as 42 --port 4000
```

`tool:list` と `tool:inspect` のオプションは次のとおりです。

| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `--routes` | アプリのルートエントリ: `routes/web.ts`、なければ `routes/api.ts`(`check`・`audit` と同じ探索) | ルートエントリファイルのパス |
| `--app` | カレントディレクトリ | アプリケーションルートディレクトリ |
| `--json` | `false` | 導出結果を JSON で出力 |

`tool:call` はさらに踏み込んで、MCP クライアントから呼ばれたときと同じディスパッチ契約で、ツールを実際に呼び出します。アプリケーションを起動するので、ツールの一覧は動いているアプリが持つグラフから取ります。そのため `--routes` は受け付けません。

```bash
# 引数付きでツールを呼ぶ
bunx guren tool:call posts.store --input '{"title":"Hello agents"}'

# 予行演習: ミドルウェアを通し契約を検証して、ハンドラーの手前で止める
bunx guren tool:call posts.store --input '{"title":"Hello"}' --preflight

# ユーザーとして呼び、結果を JSON で読む
bunx guren tool:call posts.index --as user:42 --json
```

| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `--input` | `{}` | ツールの引数を JSON オブジェクトで指定 |
| `--as` | (未認証) | 指定したユーザーとして呼び出す(`user:42`)。開発専用。プロセスに `GUREN_TESTING=1` を設定し、実際の資格情報の代わりに注入したユーザーをアプリが受け入れるようにする。パスワードはテスト用の軽いパラメータでハッシュされる([テスト](./testing.md#テストでのパスワードハッシュ)を参照) |
| `--preflight` | `false` | 実行する代わりに判定(verdict)だけを求める。ハンドラーは実行されない |
| `--app` | カレントディレクトリ | アプリケーションルートディレクトリ |
| `--json` | `false` | 呼び出し結果を JSON で出力 |

呼び出しの結果がエラーだった場合、コマンドは 0 以外で終了します。スクリプトが 422 や 403 を成功と読み違えないようにするためです。[エージェントインターフェース: 自分でツールを呼ぶ](./agent-interface.md#自分でツールを呼ぶ)も参照してください。

起動したアプリケーションに[監査ログ](./agent-tool-governance.md#監査ログ)が設定されていれば、この呼び出しも `surface: 'cli'` として記録されます。書き込み先も引数のマスクも MCP からの呼び出しの記録とまったく同じで、同じファイルに並びます。この経路での呼び出しは `--as` で指定したユーザーとして、何も検証されずに実行されるので、あとから確認できるようにしておく意味があります。監査ログを設定していないアプリケーションでは何も記録されず、呼び出しの動きも変わりません。

`tool:dev` は、アプリ自身のエンドポイントをそのまま立ち上げます。[`@guren/plugin-mcp`](./agent-interface.md) をインストールして登録しておく必要があり、エンドポイントが応答しない場合はそのことを報告します。発行されるトークンはそのプロセスのメモリ上にしかなく、アプリのトークンストアには何も書き込みません。コマンドを止めればトークンも無効になります。`NODE_ENV=production` のときは実行を拒否します。

| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `--as` | プレースホルダ ID | ツール呼び出しで認証済みとして扱うユーザー ID。デフォルト値はどのレコードにも一致しないので、ツールの一覧は取れるが、ポリシーがユーザーを読み込む呼び出しははっきり失敗する |
| `--path` | `/mcp` | プラグインを別のパスにマウントしている場合のエンドポイントパス |
| `--port` | `3333` | 待ち受けポート(`0` で空きポートを自動選択) |
| `--host` | `127.0.0.1` | バインドするホスト名 |
| `--app` | カレントディレクトリ | アプリケーションルートディレクトリ |

> [!WARNING]
> 表示されるトークンには `tools:*` の権限が付いています。デフォルトではループバックにバインドするので手元の外には出ませんが、`--host 0.0.0.0` を指定すると、コマンドを実行している間、エンドポイントとトークンにネットワークから到達できるようになります。

`tool:log` は監査ログを読み出します。この節のほかのコマンドと違い、アプリケーションは起動しません。記録を取ったアプリが起動しなくなっていても、監査ログは読めるようにしておくためです。

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

| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `--file` | `storage/logs/agent-audit.log` | 監査ログのベースパス。日付付きのファイルはこの隣に置かれる |
| `--tail`・`-f` | `false` | 新しいレコードが届くたびに表示する。日付が変わってファイルが切り替わっても追い続ける |
| `--tool` | (すべてのツール) | 指定したツールのレコードのみ |
| `--surface` | (すべてのサーフェス) | `mcp`・`dev-mcp`・`cli`・`webmcp`・`durable`・`in-process` のいずれかのみ |
| `--denied` | `false` | 拒否のみ |
| `--since` | (制限なし) | `30m`・`2h`・`7d` などより新しいレコードのみ |
| `-n` | `50` | 表示件数 |
| `--app` | カレントディレクトリ | アプリケーションルートディレクトリ |
| `--json` | `false` | 1 行 1 レコードの生データで出力。パイプ処理向け |

`-n` はフィルタを適用した**あと**に効きます。つまり `--denied -n 50` は「直近 50 件の拒否」で、「直近 50 件のうちの拒否」ではありません。レコードは、シンクを設定したあとの分しか残りません。監査ログの設定は任意なので、ログが見つからない場合は、追加すべき設定行を表示します。[エージェントツールの権限と監査: 監査ログ](./agent-tool-governance.md#監査ログ)も参照してください。

表示される内容は、どれもルートがすでに持っている契約から導出されます。入力スキーマは `params`・`query`・`body` をマージしたもの、出力スキーマは `output`、認可の ability はミドルウェアチェーンが実際にチェックしているポリシーのものです。同じことを 2 か所で宣言する必要がないので、エンドポイントが検証しないスキーマをツールが掲げることはありません。

`bunx guren codegen` は、同じ導出結果を `.guren/agents.gen.ts` に書き出します。ツールを 1 つも公開していないアプリではこのファイルは生成されず、すでにあれば削除されます。

## 設定コマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `config:cache` | 全設定ファイルをキャッシュ | `bunx guren config:cache` |
| `config:clear` | 設定キャッシュをクリア | `bunx guren config:clear` |
| `config:show` | 設定キャッシュ情報を表示 | `bunx guren config:show` |

### 設定キャッシュ

本番環境のパフォーマンスを上げるために、設定ファイルをキャッシュします。

```bash
# 全設定をキャッシュ
bunx guren config:cache

# キャッシュをクリア
bunx guren config:clear

# キャッシュ情報を表示
bunx guren config:show
```

キャッシュは `bootstrap/cache/config.json` に保存されます。設定ファイルは `config/` ディレクトリ(サブディレクトリを含む)から読み込みます。

**Note:** 設定ファイルを変更したら、`config:cache` をもう一度実行してキャッシュを更新してください。

## データベースコマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `db:migrate` | 保留中のマイグレーションを実行 | `bunx guren db:migrate` |
| `db:rollback` | マイグレーションを取り消す方法を表示(マイグレーションは前進のみ) | `bunx guren db:rollback` |
| `db:reset` | 全テーブルを削除してマイグレーションを再実行 | `bunx guren db:reset` |
| `db:seed` | データベースシーダーを実行 | `bunx guren db:seed` |

### db:migrate オプション

`db:migrate` は、`config/database.ts` の `migrationsFolder`(雛形から作ったアプリでは `db/migrations`)にある、まだ適用していないマイグレーションをすべて適用します。確認を求めないので、デプロイのパイプラインから人手を介さずに実行できます。

適用する前に、未適用の `migration.sql` をすべて読みます。テーブルやカラムの削除、カラムの型を狭める変更、SQLite のテーブル再作成、リネーム、`TRUNCATE`、全行の `DELETE` があり、そのマイグレーションに `-- guren:allow-destructive` のコメントがなければ、0 以外の終了コードで適用を拒否します。該当する文は `db/migrations/<folder>/migration.sql:<line>` の形で表示され、この拒否は環境を問いません。対象と承認の書き方は[破壊的マイグレーション](database.md#破壊的マイグレーション)で説明しています。

```bash
# マイグレーションを実行
bunx guren db:migrate

# 適用せずに、未適用のマイグレーションに破壊的な文がないかを確かめる
# (承認のない文があれば終了コード 1。データベースのトラッカーを読みます)
bunx guren db:migrate --dry-run

# 承認のない破壊的な文も、この 1 回だけ適用する
bunx guren db:migrate --allow-destructive

# 結果を JSON で出力。`destructive` に判定の内容が入ります
bunx guren db:migrate --json
```

### db:rollback

マイグレーションは drizzle-kit が生成する前進専用のもので、ロールバックできるバッチはありません。`db:rollback` はオプションを受け付けず、代わりの手順を表示して 0 以外の終了コードで終わります。そのため、このコマンドを呼んだスクリプトはそこで止まります。代わりの手順は次のとおりです。

- 開発環境では、`bunx guren db:reset --seed` で全テーブルを削除し、すべてのマイグレーションを適用し直します。
- まだコミットしていないマイグレーションを捨てたい場合は、`db/migrations/` にあるそのフォルダを削除してから `bunx guren db:reset` を実行します。
- 本番環境では、`db/schema.ts` の変更を元に戻し、`bunx guren make:migration` で新しいマイグレーションを生成します。

### db:seed オプション

`db:seed` は、`config/database.ts` の `seedersFolder`(雛形から作ったアプリでは `db/seeders`)にあるシーダーを、ファイル名の順にすべて実行します。特定のシーダーだけを実行するオプションはありません。実行順を決めたいときは、ファイル名に `001_`、`002_` のような接頭辞を付けてください。

```bash
# 全シーダーを実行
bunx guren db:seed

# 本番環境でシーディングを強制実行
bunx guren db:seed --force

# 実行せずに、何が起きるかだけを表示
bunx guren db:seed --dry-run

# 実行結果のサマリを JSON で出力
bunx guren db:seed --json
```

> [!NOTE]
> `--json` を付けると、コマンド自身のサマリが JSON で出力されます。シーダーの標準出力は抑えられず、そのまま出ます(`make:seeder` が生成する雛形は 1 行のログを出します)。`jq` に流すときは、シーダー側のログを止めてください。

## キューコマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `queue:work` | キューに入ったジョブの処理を開始 | `bunx guren queue:work` |

### queue:work オプション

```bash
# デフォルトキューからジョブを処理
bunx guren queue:work

# 特定のキューを処理
bunx guren queue:work --queue emails

# ジョブ数を制限
bunx guren queue:work --max-jobs 100

# キューが空になったら停止
bunx guren queue:work --stop-when-empty
```

## 共通オプション

`make:*` と `add` のコマンドには、共通の書き込みオプションが 1 つあります。

- `--force` / `-f`: 既存のファイルを上書きする。`add ai` と `add prototype` は `--force` だけを受け付け、`-f` は使えない

コマンドはアプリのルートディレクトリで実行します。カレントディレクトリが対象になります。

## テンプレートの特徴

生成されるコードは、フレームワークの Laravel 風の設計方針に沿っています。

- コントローラーは `Controller` を継承し、`this.inertia()` などのヘルパーを使う。
- モデルは `Model<TRecord>` を継承し、`static table` をあらかじめ設定してある。手軽な CRUD はヘルパーで、複雑なクエリは Drizzle RQB で直接書く。`Model.newQuery().toDrizzle()` を使えば、モデルのスコープを保ったまま Drizzle のクエリを書ける。
- ビューは React + TypeScript + Tailwind CSS の関数コンポーネント。

生成したあとは、ルートの配線と、Drizzle スキーマへの `static table` の接続を忘れないでください。高度なクエリは、モデルのスコープを保つ `toDrizzle()` か、モデルを通さない Drizzle の DB(`getDatabase()`)で書きます。

## 新規アプリのスキャフォールド

ゼロから始めるときは、専用のブートストラッパーを使います。

```bash
bunx create-guren-app my-app --mode ssr
```

CLI はデフォルトのテンプレートをコピーし、メタデータを書き換えます。`--mode ssr`(デフォルト)なら SSR が有効になり、`--mode spa` なら無効になります。空でないディレクトリに生成するときは `--force` を付けます。

雛形を作るときには、[エージェントハーネス](./agent-harness.md#エージェントを選ぶ)を入れるエージェントを選ぶよう求められます。`--agents codex,cursor` のように指定するか、`--agents none` でハーネスを入れずに済ませられます。

## トラブルシューティング
- `command not found: bunx`: Bun が古いのかもしれません。サポートの基準になっている Bun 1.4.4 をインストールしてください。
- `Error: Port already in use`: 開発サーバーのポート(デフォルトは 3333)がほかで使われています。`.env` の `PORT` を変えてから再起動してください。
- `Database connection failed`: 新しいアプリは SQLite（`./data/guren.db`）を使うので、`.env` の `DATABASE_URL` を確認してください。`--db postgres` や `--db mysql` で作ったアプリでは、データベースが起動していて（`bun run db:up`）、`DATABASE_URL` がそれを指していることを確かめてください。

## 対話 REPL

フレームワークを読み込んだ状態のコンソールを起動します。

```bash
bunx guren console
```

> これは対話型の REPL で、アプリケーションが定義するコマンドとは別物です。アプリケーション側のコマンドを実行するには `bun run console <command>` を使います([コンソールコマンドガイド](./console.md)参照)。

アプリケーションを起動し(`src/main.ts` と登録済みのプロバイダーをそのまま使います)、`app`、`auth`、見つかったモデル、DB ヘルパー、`@guren/testing` のユーティリティなどを読み込んだ状態のプロンプトに入ります。`:help` でショートカットの一覧、`:editor` で複数行の入力が使えます。

### 典型的な流れ

1. **起動**: プロジェクトルートで `bunx guren console` を実行します。
2. **コード実行**: `src/main.ts` などで初期化したスコープを共有しているので、`await Post.all()` のような文をそのまま実行できます。
3. **状態リセット**: `Ctrl+D`(または `.exit`)で終了し、必要ならもう一度起動します。

### Tips

- `Ctrl+D` か `.exit` で REPL を抜けられます。
- コンソールの起動中に追加したモデルは、`reloadModels()` で検出し直せます。
- `:load path/to/script.ts` で、ファイルの内容を今のセッションに読み込めます。
- 素の Bun REPL が欲しいときは、`bun repl`(または `bun repl --inspect`)を使ってください。

専用の `guren repl` ができるのを待たなくても、これらの使い方で試行錯誤しながら開発を進められます。

## アプリ構造と実行時エラーの取得

| コマンド | 説明 | 例 |
|---------|------|-----|
| `graph` | アプリの配線（ルート、コントローラー、モデル、ページと、それらを結ぶ根拠）を、ディスク上のプロジェクトから読んで出力する | `bunx guren graph --json` |
| `runtime:errors` | 開発中のアプリで最近起きたサーバーエラーを一覧する（`GUREN_MCP=1` が必要） | `bunx guren runtime:errors --json --url http://127.0.0.1:3333` |

どちらのコマンドも、同じデータをコーディングエージェントに渡す MCP ツールや Dev Center とあわせて、[アプリ構造と実行時エラー](./application-diagnostics.md)で説明しています。

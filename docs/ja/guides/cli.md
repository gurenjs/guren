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

個々のファイルを作る `make:*` ではなく、標準的な構成をひとまとめに入れたいときは `bunx guren add ...` を使います。

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
```
> **Golden path:** まず `bunx guren add auth` と `bunx guren add resource` から始め、アプリが育つのに合わせてほかの機能を足していってください。

```bash
bunx guren plugin @acme/guren-plugin-audit
```

`plugin`(`add plugin` とも書けます)を実行すると、まず依存がまだ入っていなければ `bun add` でインストールします(`--no-install` で省略できます)。次に、プラグインが宣言している Guren のバージョン互換性を確かめ(`--ignore-compatibility` で無視できます)、Provider を `src/app.ts` に登録します。プラグインが `gurenPlugin` マニフェストで宣言した設定スタブや環境変数のキーも反映します。公開済みのファイルを上書きしたいときは `--force` を付けます。

これらのコマンドは `src/app.ts` を書き換え、必要な provider や runtime のファイルを生成します。

lint の設定は、`create-guren-app` 1.12 以降で作ったアプリには最初から入っています。`add lint` はそれより前に作ったアプリ向けのコマンドで、アプリのコードには手を付けません。実行すると `.oxlintrc.json` を書き出します。中身は `@guren/cli/oxlint` の Guren ルールを入れた oxlint の設定で、`guren/await-async-assertion` は error、`app/`・`config/`・`routes/`・`src/`・`modules/` に対する `guren/no-unvalidated-env-read` は error、`guren/comment-*` は warn です。あわせて `lint` / `lint:fix` スクリプトを追加し、`oxlint` を `~` レンジで devDependency に加えます。oxlint の JS プラグイン API はまだ alpha なので、パッチ更新だけを受け入れるようにしています。実行したら `bun install` してください。`bunx oxlint` は Bun 上で動くので、Node は要りません。`config/env.ts` が導入される前に作ったアプリでは、自前の `config/database.ts` や `src/app.ts` にある `process.env` の読み取りも、スキーマに移すか無効化のコメントを付けるまで、このルールに報告されます。

`bunx guren add admin` を実行すると、次のファイルができます。

- `app/Http/Controllers/Admin/AdminDashboardController.ts`
- `resources/js/pages/admin/Dashboard.tsx`
- `routes/admin.ts`(`routes/web.ts` がある場合は自動配線)

ダッシュボードは**デフォルトでログインが必要**です。`routes/admin.ts` が `/admin` に `requireAuthenticated({ redirectTo: '/login' })` を付け、コントローラーでも `this.auth.userOrFail()` を呼びます。`make:feature --public` は更新系のアクションだけを公開しますが、こちらの `--public` はダッシュボード全体を公開します。

```bash
bunx guren add admin --public
```

`add auth` より先に `add admin` を実行してもかまいません。その場合もガードは効いていますが、認証を入れていないアプリにはサインインしたユーザーがいないので、すべてのリクエストが `/login` にリダイレクトされます。`/login` は `bunx guren add auth` を実行して初めてできるルートです。実際に使えるダッシュボードにしたいなら、先に認証を追加するか、`--public` を付けてあとから独自のチェックを書いてください。

`add admin` はフルスタックのアプリでしか使えません。ダッシュボードは Inertia のページなので、`api` ブループリントで作ったアプリ(`@guren/inertia-client` への依存も、web ルートのエントリである `routes/web.ts` / `routes/web.js` もないアプリ)では、コマンドが理由を表示して中断し、何も生成しません。型検査を通らないコントローラーや、どこにもマウントされないルートファイルを書いてしまわないためです。管理用のエンドポイントは `make:controller` で生成し、`routes/api.ts` に登録してください。

`add auth` も同じ理由でフルスタック専用で、同じ 2 つの手がかりを見て中断します。同じ雛形を生成する `make:auth` も同様です。auth は `db/schema.ts` へのパッチやマイグレーションの生成も行いますが、中断はそのどれよりも前、最初のファイルを書き込む前に起こるので、アプリは元のまま残ります。トークンベースの API にしたい場合は、`@guren/core` の `createBearerTokenMiddleware` で `routes/api.ts` を保護し、`createApiToken` でトークンを発行してください([APIトークンガイド](./api-tokens.md)参照)。

`add resource` も同じ 2 つの手がかりを見て、同じ理由で中断します。React のページコンポーネントと、Inertia のレスポンスを返すコントローラーを生成するコマンドだからです。この中断も、`db/schema.ts` にテーブルを追記する前に起こります。同じ雛形を直接生成する `make:feature` も同じように中断します。JSON を返すコントローラーは `make:controller` で生成し、`routes/api.ts` につないでください。

`add prototype` は、プロトタイプモード([プロトタイプファースト](./prototype-first.md))を導入するコマンドです。実行すると、シードデータで Inertia の visit に応答する `resources/js/prototype/` の fixture、`dev:prototype` と `build:prototype` のスクリプト、`resources/js/app.tsx` と `src/app.ts` に入るローダー 2 行が追加されます。`--remove` を付けると、スクリプトとローダーを取り除きます。

続けて `make:feature <Entity> --fields "…" --prototype` を実行すると、機能のうち画面に見える部分(ページ、バリデーター、ページデータ型、fixture のエントリ)を書き出し、`prototype` ハンドラーで登録するルートを表示します。そのエンティティのルートがまだ `prototype` で動いているアプリで、同じコマンドをフラグなしで実行すると昇格になります。モデル、Resource、コントローラーが書き出され、Resource はページデータ型に合わせて型付けされます。ページには手を付けません。`bun run build:prototype` は Vite の前に `check --prototype` を実行するので、fixture にエントリがないルートは、顧客がクリックしたときではなくビルドの時点で失敗します。

`add ai` は、`@guren/plugin-ai` を使ったインプロセスの AI エージェントを導入します。プロバイダを 1 つ(`--provider anthropic`、`openai`、`gateway` のいずれか)選ぶと、そのプロバイダ用の `config/ai.ts` を書き出し、API キーを `config/env.ts` と env ファイルに宣言し、設定と `aiPlugin()` を `createApp()` に登録します。そのあとプラグイン、`ai`、プロバイダのパッケージを `bun add` します。`--no-install` を付けると、実行するコマンドを表示するだけになります。キーは任意なので、設定していなくてもアプリは起動し、最初のプロンプトを送った時点で失敗します。

このコマンドを使うには `config/env.ts` が必要です。`db/schema.ts` があるアプリでは、`ai_conversations` と `ai_messages` の 2 つのテーブルを追加してマイグレーションを生成し、会話をそこに保存するよう `config/ai.ts` を設定します。`--no-conversations` を付けると、この処理を省きます。テーブルには、ツールの結果も含めてモデルが見た会話がそのまま残るので、機密データとして扱ってください。

エージェントクラスは、そのあと `make:ai-agent <Name>` で `app/Ai/Agents` に書き出します。`--tools` に指定したエージェントツールは、ルートから導出できることを確かめたうえでエージェントに渡されます。`--output` を付けると構造化出力のスキーマの雛形が加わり、`--test` を付けると `app.fakeAi()` でモデルの応答を台本にしたテストが書き出されます。スコープ、会話、ストリーミング、キューについては [AI エージェント](./ai-agents.md) で説明しています。

`make:controller` も同じ 2 つの手がかりを読みますが、中断はせず、アプリに合わせた出力をします。API 専用と判定したアプリでは、Inertia ページではなく JSON(`this.json(...)`)を返すコントローラーを生成するので、そのまま型検査を通り、`routes/api.ts` にもそのままつなげます。手がかりから API 専用だと確認できなければ、通常の Inertia 用のテンプレートを生成します。`@guren/inertia-client` をインストールすれば、通常のテンプレートに戻ります。

`make:view` は、上で説明した雛形生成コマンドと同じく、同じ手がかりを見て中断します。ページには代わりになる JSON 版がなく、そのアプリにはページを描画する手段がないからです。`guren codegen`(`bun run dev` が自動で実行します)は、そうしたコンポーネントを `.guren/pages.gen.ts` から外します。このファイルは、API 専用アプリには入っていない `@guren/inertia-client` を import するためです。この中断の目的は、`typecheck` が壊れるのを防ぐことよりも、壊れる原因を作ったコマンドの時点でそれを知らせることにあります。API アプリをフルスタックにするときは、先に `@guren/inertia-client` をインストールすれば、また使えるようになります。

`add resource` は、アプリの形にかかわらず、パッチを当てる 2 つのファイルがそろっていることも求めます。テーブル定義を `db/schema.ts` に追記し、CRUD ルートを `routes/web.ts` に登録するので、どちらもあらかじめ存在していなければなりません。さらに、対象のルートがまだ登録されていない場合は、`routes/web.ts` がパッチを当てられるルートレジストラを export している必要があります。どれかが欠けていると、コマンドは足りないものを示して、何も生成しません。生成したファイルだけが残り、登録されないルートのためのテーブルが `db/schema.ts` に追記された状態になるのを避けるためです。2 つのパッチなしでファイルだけ欲しい場合は、`bunx guren make:feature` を使ってください。貼り付け用のルートのブロックを表示し、テーブル定義を追記するスキーマファイルも教えてくれます。

どちらのコマンドも、最初のファイルを書く前に、書き出す予定のファイルをすべて確認します。手書きのモデルなど、すでにあるファイルが見つかれば、該当するものをすべて一覧にして中断し、何も書き込みません。`add resource` の場合は、`db/schema.ts` と `routes/web.ts` も変更しません。`--force` を付けると、一覧のファイルは手書きのものも含めてすべて上書きされます。`--test`・`--factory`・`--policy` を付けたときだけ追加されるファイルには、一覧にそのフラグが添えてあり、フラグを外せば衝突を避けられます。プロトタイプからの昇格では、プロトタイプのときに書いたページとバリデーターをそのまま残すので、これらは既存のファイルとして数えません。

複数のファイルを書き出すほかのコマンドも、最初に書き込む前に同じ確認をして中断します。対象は `make:auth`、`make:module`、`make:ai-agent`(`--test` がフラグにあたります)、`deploy`、そして `add` の各ブループリントで、サンプルのイベント・ジョブ・Mailable も含みます。ファイルを 1 つだけ書く `make:*` コマンドも、同じメッセージで中断します。例外は、途中まで入ったものを再実行で補うためのブループリント(`add session`、`add cache`、`add schedule`、`add ai`、`add prototype`)で、既存のファイルは残し、足りないものだけを書き出します。

## 主要コマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `key:generate` | 新しい `APP_KEY` 値を生成。`--write` で `.env` に保存 | `bunx guren key:generate --write` |
| `deploy` | Docker/Fly.io/Railway 向けデプロイ設定ファイルを生成 | `bunx guren deploy --target all --app my-app --port 3333` |
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

| コマンド | 説明 | 例 |
|---------|------|-----|
| `check` | ルート・コントローラ・ページ・モデルの整合性を検証する。`routes/` 配下の各ファイルがエントリのレジストラから、モジュールの `routes/` 配下が各モジュール自身のレジストラから実際に呼ばれているかも確かめる。ほかに、`config/agents.ts` の永続エージェントレジストリ、インプロセスエージェントの `appTools()` の名前とスコープ、deferred props(ページの `Props` が必須として宣言している prop に `defer()` を渡していないか。ゲートを止めない参考扱い(advisory)の警告)、doc リンク、スペックビューが最新か、アーキテクチャ境界も検証する | `bunx guren check --json` |
| `audit` | セキュリティ監査。更新系ルートでのバリデーション・認証・Policy による認可の抜け、文字列を埋め込んだ生 SQL、ハードコードされた認証情報、無効にされたセキュリティのデフォルト設定、mass assignment の設定、`hidden` に入っていない機微なカラム、リクエストのホストから組み立てたメール内のリンク、アプリやインストール済みパッケージが宣言した CSRF の除外、インプロセスエージェントのローカルツールを調べる | `bunx guren audit --json` |
| `gate` | 雛形に含まれる CI が実行する検証ステージ(codegen・typecheck・lint・`--ci` の規則での `check`・`audit`・テスト)をまとめて実行し、どれかが失敗すれば非ゼロで終了する。実行できないステージは、スキップではなく失敗として扱う | `bunx guren gate --changed` |
| `introspect` | boot も listen もせずにアプリの provider とルートを登録し、マニフェストを出力する。マニフェストには、provider ごとの登録結果、解決済みのミドルウェアとコントローラのファイルを含むルート、session・auth・cache・storage・queue・attachments の設定が入る | `bunx guren introspect --json` |
| `doctor` | プロジェクトの健全性(環境変数・設定・生成ファイル)のレポートと、次にやるべきこと | `bunx guren doctor --next` |
| `context [Entity]` | プロジェクトのコンテキストマップ。エンティティ名を渡すと、1 つのモデルに関するものをすべて出力する。対象は、テーブル、リレーション、`fillable`/`hidden`/`visible`/`casts`、スキーマ付きのルート(`<Entity>Controller`、モデルを指す `bind`、モデルを使うアクション本体のどれかで対応付ける)、Props 付きのページ、Resource、Policy、紐付いた docs と Issue。同名のモデルは `--module` で区別し、`"app"` はプロジェクトルートを指す。`--live` を付けると `gh` に Issue の状態を問い合わせ、`--repo owner/name` で origin リモートの代わりのリポジトリを指定できる | `bunx guren context User --json` |
| `docs:graph` | OKF docs のリレーショングラフ。文書・エンティティ・コードパスがノードで、検証済みのリレーションがエッジになる。`--entity <Model>` / `--path <file>` で周辺だけに絞れるので、リネームの前に「これを規定している docs はどれか」を調べられる | `bunx guren docs:graph --path app/Http/Controllers/PostController.ts` |
| `spec:generate` | `docs/spec/` にある導出スペックビュー(ER 図・ドメインモデル・画面一覧・モジュールマップ)を生成し直す。詳しくは[スペックアンカード開発](./spec-anchored.md)を参照 | `bunx guren spec:generate` |

`audit` は失敗(fail)を見つけると非ゼロの終了コードを返します。フラグなしの `check` は報告するだけですが、スイートを選ぶフラグを付けると、そのスイートに失敗があったときに非ゼロで終了します。雛形に含まれる CI ワークフローは、後で説明する `gate` を実行します。

```bash
bunx guren audit
bunx guren check --arch    # アーキテクチャ境界(guren.arch.ts + モジュールルール)
bunx guren check --docs    # docリンク: OKF frontmatter(type/entities/related)+ 本文リンク + @docsタグ
bunx guren check --spec    # docs/spec/ が再生成結果と一致するか
bunx guren check --prototype  # prototype ハンドラーのルートに名前付きの fixture エントリがあり、ローダーが配線されているか
```

`audit` の Policy ルールは、警告(warn)までしか出しません。あるモデルに対する Policy(`make:policy` が書く `app/Policies/<Model>Policy.ts`。同じアプリルートの中で対応付けます)が 1 つでもあると、安全でないメソッドのコントローラアクションのうち、本体でそのモデルを参照しているものに `policy:<METHOD> <path>` の指摘が付きます。アクションが次のどれかに当てはまれば合格(pass)です。

- `this.authorize()` か `this.can()` を呼んでいる
- ゲートに問い合わせている
- Policy クラスを参照している
- `authorize()`/`authorizeResource()` ミドルウェアの後ろにある

スキャンで見える範囲で Policy を参照していなければ、アクション名、Policy 名、直し方を添えて警告します。コントローラのソースが読めなかった場合も、合格にはせず警告します。アクションが呼んでいるヘルパーの中までは追いかけません。認可の判定を別の場所で行っているアクションには、その上のコメントに `// guren-audit-ignore` と書いてください。その指摘は、このコメントを理由に無視済み(`ignored`)として報告されます。Policy がないアプリでは、この指摘は出ません。

スイートのフラグを複数付けると、それぞれのスイートをすべて実行します。`--changed` を付けると、どのスイートも main とのマージベースから変更されたファイルだけを対象にします。エージェントハーネスが編集のたびに走らせる hook は、この速い経路を使っています。

指摘の中には、ファイルを生成し直せば消えるものもあります。`.guren/*.gen.ts` マニフェストがない場合(`guren codegen`)と、`docs/spec/` のビューが古い場合(`guren spec:generate`)です。`check --json` は、こうした指摘に `fix` フィールドを付けます。中身は `{ "kind": "command", "args": ["codegen"] }` のような、`guren` に続く引数です。`--fix` を付けると、重複を除いた fix を 1 回ずつ実行してからもう一度チェックし、2 回目の結果を報告します。実行したコマンドは `fixes` に入ります。どれかのコマンドが失敗したときや、コマンドは成功したのに消えるはずの指摘が残ったときは、非ゼロで終了します。`--ci` と `--fix` は同時に指定できません。ゲートが古いファイルを自分で生成し直すと、いつでも通ってしまうからです。`--fix` は手元で実行し、書き換わったファイルをコミットしてください。コードの修正や判断が必要な指摘には `fix` が付かず、`suggestion` の文章だけが付きます。

```bash
bunx guren check --fix          # 指摘が示すファイルを再生成して、もう一度チェック
bunx guren check --spec --fix   # 同じことをスペックビューに限って行う
```

`gate` は、「この変更は終わったか」に 1 つの終了コードで答えるコマンドです。雛形に含まれる CI ワークフローが実行するステージ、つまり codegen、typecheck、lint(アプリに `.oxlintrc.json` がある場合)、`--ci` の規則での `check`、`audit`、テストスイートをすべて実行し、ステージごとに結果を報告して、どれかが失敗すれば非ゼロで終了します。実行*できない*ステージは、スキップではなく失敗として扱います。たとえば、`.oxlintrc.json` があるのに oxlint が入っていない、`typecheck` スクリプトがない、routes のエントリが読み込めない、といった場合です。lint をスキップするのは、`.oxlintrc.json` がないアプリだけです。

`check` と `audit` のステージは、イントロスペクションの結果を読みます([イントロスペクションの結果を読むチェック](#イントロスペクションの結果を読むチェック)参照)。イントロスペクションは 1 回の実行につき 1 回(上限 10 秒)で、codegen のあとに行うので、clone したばかりのアプリでもエントリを import できます。イントロスペクションが失敗しても、それを必要としたステージに参考扱いの行を 1 行加えるだけで、ゲートは失敗にしません。`-unverified` の結果も、アプリが確認できなかった理由を添えて、check ステージに参考扱いの行として表示します。ただし、ソースを変更していない `--changed` の実行ではイントロスペクションを行わないので、この行は出ません。`guren plan:verify` も、check のステップで同じ行を表示します。

```bash
bunx guren gate            # 全ステージをフルで
bunx guren gate --changed  # check と lint を変更ファイルに限定(typecheck・audit・テストはフルのまま)
bunx guren gate --deps     # audit ステージに依存関係スキャンを追加
bunx guren gate --json     # ステージごとのレポート(ツール向け)
```

雛形に含まれる `.github/workflows/ci.yml` は `bunx guren gate --deps` の 1 ステップだけなので、手元でゲートを通した変更は CI でも通ります。Claude Code のハーネスはこのコマンドを `Stop` hook から実行し([AIエージェントハーネス](#aiエージェントハーネス)参照)、MCP サーバは `guren_gate` ツールとして公開しています。そのほかのエージェントには、変更が終わったと言う前に実行するよう `AGENTS.md` で指示しています。

名前付きミドルウェアで保護したルート(例: `router.middleware('auth').group(...)`)は、保護済みとして扱われます。`/login` や `/register` などのゲスト向けのフローは、認証チェックの対象外です。

### 登録済みアプリのイントロスペクション

`guren introspect` は、ソースコードの文面ではなく、アプリそのものから答えを得ます。`GUREN_INTROSPECT=1` を付けた子プロセスで `src/main.ts` を import し、すべての provider とルートを登録したところで止まります。ルートはマウントしません。provider の `boot()`、`createApp({ boot })` のコールバック、`listen()` は実行しないので、ポートは使わず、`boot` で接続する雛形の `defineDatabaseConfig()` の定義もデータベースにつなぎません。一方、モジュールスコープや `register()` で接続するコードは実行されます。子プロセスは `guren dev` と同じくアプリのルートにある `.env` を読み込み、シェルで設定した変数はそれより優先されます。`--app` を使う場合は、カレントディレクトリの `.env` も CLI が読み込んで同じ経路で子プロセスに渡すので、こちらもアプリの `.env` より優先されます。

```bash
bunx guren introspect                 # provider・ルート・サービス・警告を表で表示
bunx guren introspect --json          # ツール向けのマニフェスト
bunx guren introspect --timeout 60    # 遅い register() を 60 秒まで待つ(既定は 30 秒)
bunx guren introspect --app ../api    # 別のアプリのルートを調べる
```

provider ごとに、登録の結果が次のどれかで示されます。

- `ran`
- `introspect-hook`: `introspect()` が定義されていて、`register()` の代わりにそれを実行した
- `threw`: 例外のメッセージを記録し、ほかの provider の登録は続ける
- `skipped`: deferred provider

`register()` で接続を開いたり、実行時のバインディングを読んだりする provider は、`introspect()` を定義して、マニフェストに必要なものだけをバインドできます。

```ts
import { ServiceProvider } from '@guren/core'
import Redis from 'ioredis'

export class RedisProvider extends ServiceProvider {
  register(): void {
    // Connects as soon as it is constructed.
    this.container.instance('redis', new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379'))
  }

  introspect(): void {
    // The manifest does not describe 'redis', so nothing needs binding here.
  }
}
```

provider の外のコードでは、`isIntrospecting()` で同じ判定ができます。このフラグが立っていると、`app.boot()` は登録を終えたところで止まり、`app.listen()` は例外を投げます。そのため、import の途中で `listen()` を呼ぶエントリは失敗し、`bin/serve.ts` の形に直すよう案内するメッセージが出ます。失敗したときは、`--json` が `{ "status": "failed", "reason", "message" }` を出力し、終了コードは 1 になります。reason は `no-entry`、`import`、`timeout`、`crashed`、`old-server` のどれかです。`old-server` は、introspection に対応する前の `@guren/core` がインストールされている場合で、エントリを import する前に検出します。

### イントロスペクションの結果を読むチェック

`guren check` と `guren doctor` は、デプロイ実行環境の判定を、まずイントロスペクションの結果をもとに行います。具体的には、auth manager が持つハッシャー、選ばれているセッションストアとキャッシュストア、登録中に例外を投げた provider があるかどうかを確かめます。`guren check` は、セッションと添付ファイルの配線もこの結果から判定します。

| チェックキー | イントロスペクションの結果から読むもの |
|--------------|----------------------------------------|
| `sessions-binding` | `register()` で `session` をバインドする provider があるか。アプリが読まないセッション設定(バインドがない、または `auth.sessionOptions.store` が代わりにストアを渡している)は警告になる。バインドしたマネージャと `auth.sessionOptions.store` を併用すると、アプリが boot を拒否するので失敗になる |
| `sessions-config:*` | バインドされたセッションマネージャの `database` ストアが使うテーブルの SQL 名。モジュールも含め、各アプリルートの `db/schema.ts` が宣言するテーブルと照らし合わせる。スキーマの読み取りで見つからない名前は、参考扱いの警告にとどめる。それも、ソースからスキーマの export をたどれないテーブルに限る。この読み取りでは、`drizzle.config` が挙げるほかのファイルも、`pgTableCreator()` の接頭辞も見ない。判定は、そのストアを宣言しているすべての設定に付く。ソースから読めるどの設定もストアを宣言していない場合は、ファイルを持たない `sessions-config:<store>` のキーで報告する |
| `attachments-model:*`、`attachments-config:*` | アプリの登録中に添付ファイルのエンジンが設定されたかと、そのエンジンが書き込むテーブル。テーブルはセッションと同じように照らし合わせ、ファイルを持たないキーは `attachments-config` になる。どの `configureAttachments()` もファイルの読み込み時に必ず実行される位置(関数、分岐、クラスフィールドの外)にあり、どのソースもそのファイルを `import()` で読み込まず、`createApp({ boot })` も省略されていないのに、エンジンが設定されていなければ、モデルが失敗になる。この場合、アプリが登録中に読み込むものは、どれもそのファイルを import していない |
| `attachments-delivery` | エンジンの `delivery` が指すルートが登録されていて、それが `registerAttachmentRoutes()` のルートであるか |
| `attachments-route-name:*` | そのルート名を持つ登録済みルートの数 |
| `attachments-serve-redirect:*` | エンジンがリダイレクトで配信するディスクと、storage manager から読んだ各ディスクのドライバ |
| `attachments-public-disk:*` | エンジンが書き込むディスク。ディスクの `root` はソースから読む |
| `route-contract-*` | provider やプラグインが登録したものも含めた、登録済みのすべてのルート。params スキーマのキーは JSON Schema の `properties` から読み、失敗か警告かは `required` で決まる。JSON Schema がスキーマを表しきれない場合(nullable なオブジェクト、`z.any()` や `z.undefined()` のキー)は、同じルートをルートファイルの Zod で判定する。アプリだけが登録するルートには Zod がないので、表しきれない場合は読めないものとして報告する。注記なしに落ちたキー(`z.undefined()`)は検出できない |
| `agent-route-*` | `.agent()` を宣言したすべてのルート。コントローラはファイルと export で特定する |
| `prototype-*` | 名前付きのすべてのルート。provider が登録するルートを指すフィクスチャのエントリは、孤立したものとして扱わない。`createApp({ prototype })` の配線とフィクスチャ自体は、ソースから読む |

イントロスペクションは、それを必要とするチェックがあるときにだけ行います。対象は、デプロイプラグインか Lambda アダプタを宣言したアプリ、セッション設定があるアプリ、`configureAttachments()` を呼ぶアプリ、`Attachable(...)` を mixin したモデルがあるアプリです。ルートファイルで、params スキーマかバインディングを持つルート、`.agent()` を宣言したルート、`prototype` ルートのどれかを登録しているアプリと、プロトタイプのフィクスチャがあるアプリも対象です。

各ルールは、自分の対象があるときにだけイントロスペクションを求めます。そのため route-contract は、ルートファイルに params スキーマかバインディングがある場合にだけ、アプリだけが登録するルートを判定します。エージェントルートのルールも、ルートファイルにエージェントルートがある場合にだけ判定します。`--routes` を付けると、ルートのルールはルートファイルを読みます。マニフェストが表しているのはアプリのエントリだからです。

イントロスペクションは 1 回の実行につき最大 1 回で、ソースファイルを変更していない `--changed` の実行では行いません。マニフェストは実行環境の `.env` を読み込んだ状態で作られるので、環境変数で選ぶストアは、ローカルの値で判定されます。また、イントロスペクションは provider の `boot()` より前で止まります。そのため、関数の中で呼ぶ `configureAttachments()` については、呼び出しのオプションをソースから、ルートとストレージのドライバをアプリから読みます。

イントロスペクションは、`guren check`、`doctor`、`audit`、`gate`、`plan:verify` で行います。上限はどれも 10 秒なので、`check --ci` とゲートの判定は一致します。編集フック(`check --arch`)と dev MCP サーバの `guren_check` はイントロスペクションを行わないので、アプリでしか答えられない判定は `-unverified` になります。

これらの結果には、`--json` の出力で `evidence` が付きます。複数の事実を読む判定では、その中でいちばん弱い根拠を示します。

| `evidence` | 意味 |
|------------|------|
| `manifest` | イントロスペクションの結果を使って判定した。マニフェストにない事実(OAuth の state ストア、明示的に生成したインメモリストア)はソースの走査で補う |
| `static` | 事実がソースにあるので、ソースから判定した。provider の自動検出、ディスクの `root`、関数の中で呼ぶ `configureAttachments()` のオプション、スキーマが export すべきセッションや添付ファイルのテーブル、アプリが読まないセッション設定がこれにあたる。テーブルの export がないとイントロスペクションそのものが失敗するので、読めるのはソースだけになる。マニフェストを使わなかった理由はメッセージに書かれる |
| `none` | アプリでしか答えられないのに、それを裏付けるマニフェストがない。アプリをイントロスペクションしなかった場合、失敗した場合、`register()` で例外を投げた provider がある場合、未設定の環境変数を読む設定がバインドされなかった場合、deferred provider か自分を説明できないバインディングがそのセクションを提供している場合がこれにあたる。キーの末尾は `-unverified` になり、結果は参考扱いの警告で、合格にはならない。対象は、デプロイのハッシャーとストア、セッションのバインド、添付ファイルの配信ルートとリダイレクトのディスク |

イントロスペクションが失敗すると、`check` は理由を書いた参考扱いの `introspection-unavailable` を 1 行加えます。ソースから読める判定はソースで行い、それ以外は `-unverified` になります。`doctor` は理由を JSON の `evidenceReason` に入れます。`--no-introspect` を付けると、イントロスペクションを行いません。エントリがまだ import できないアプリで使ってください。

```bash
bunx guren check --no-introspect
bunx guren doctor --no-introspect
```

デプロイ時のビルドも同じ判定を行います。イントロスペクションの上限は 10 秒で、判定ごとに根拠を 1 行で表示します。

`guren audit` は、ルート単位のルール(`validation:*`、`authz:*`、`agent-annotation:*`)をイントロスペクションの結果で判定します。イントロスペクションは、ルートファイルが更新系のルートかボディを持つルートを登録している場合と、ルートファイル単体では読み込めない場合(アプリとしてなら登録できることがあります)にだけ行います。`--routes` を付けた場合は行いません。マニフェストが表しているのはアプリのエントリで、指定したファイルではないからです。マニフェストを使うと、判定は次のように変わります。

- ミドルウェアの別名(alias)は、アプリのどこで登録したものでも解決された状態で届きます。provider が登録する `auth` の別名の後ろにあるルートは、`authz:*` が合格になります。ルートファイルだけを読み込んだ場合は、認識できないガードとして報告されます。
- 認可はするものの認証をしないチェーンは警告のままで、メッセージに確認すべき内容が入ります。内容は、1 つの ability、複数の ability のどれかまたはすべて、リクエスト時に決まる ability のいずれかです。ゲストのリクエストは `null` ユーザーのままゲートに届くので、ポリシーが通してしまうこともあります。
- アプリのどこにも別名や group として登録されていない名前は、未解決として報告します。そのルートは boot 時のマウントで失敗するので、同じチェーンのガードより先に判定し、ガードがあっても合格にはしません。イントロスペクションが実行しない部分(`createApp({ boot })` のコールバックや、`register()` の代わりに `introspect()` フックを実行した provider)がその名前を登録する可能性がある場合は、メッセージにそのことを書きます。
- コントローラはファイルと export で特定します。2 つのモジュールがそれぞれ `ReportController` を宣言していても、各ルートは自分のクラスで判定されます。ルートのクラスがコントローラのファイルのどの export とも一致しない場合(ルートファイルの中で宣言したクラスなど)は、同じ名前で export されたクラスのボディは使いません。ルートファイルかエントリがその名前のクラスを宣言している場合も同じで、そのルートは解析できないものとして報告します。それ以外の場合は、コントローラのファイルが export せずに宣言した同名のクラスか、イントロスペクション中に import が失敗したファイルのクラスを、名前で読みます。`controller-name-collision:*` を報告するのは、この名前による読み取りで 2 つのファイルが同じ名前を宣言している場合と、クラスが再 export を通して見つかった場合だけです。ボディの検査(`validateBody()`、`userOrFail()`)は、これまでどおりアクションのソースを読みます。

`guren check` のエージェント公開ルートのルールも、同じ方法でコントローラを特定します。生 SQL、認証情報、mass assignment、CSRF の除外は、どちらの場合もソースから判定します。

ルート単位の指摘には `evidence` が付きます。マニフェストだけで決まった判定(ガードの capability、ルートが強制するボディスキーマ)は `manifest`、コントローラのボディかルートファイルを読んだ判定は `static` です。JSON の `routeSource` には何を読んだかが入り、ルートファイルを読んだ場合はその理由も入ります。イントロスペクションが失敗すると `introspection-unavailable` の警告を 1 件加えますが、終了コードは変わりません。`register()` で例外を投げた provider があると、ルールはルートファイルでの判定に戻ります。その provider が、ルートの使う別名を登録するものかもしれないからです。`--no-introspect` を付けると、ルートファイルだけを読みます。

```bash
bunx guren audit --no-introspect
```

### イントロスペクションの結果から読むルート一覧

`guren context` は、イントロスペクションで得たアプリのルートを一覧にします。provider やプラグインが登録したルートは含まれ、`createApp()` がマウントしない `modules/` 配下のモジュールは含まれません。スキーマの型はこれまでどおりルートファイルから描画するので、アプリだけが登録するルートには型が付きません。`--no-introspect` か `--routes` を付けると、ルートファイルのルートを一覧にします。アプリをイントロスペクションできない場合は、Routes の節にその理由を 1 行書き(`--json` では `routesNotIntrospected`)、ルートファイルのルートを一覧にします。`guren context <Entity>` がイントロスペクションを行うのは、2 つのファイルが宣言するコントローラクラスにルートが届く場合だけで、`--routes` を付けた場合は行いません。

`guren doctor` の `prototype-routes` は、ルートファイルが `prototype` ハンドラを使っている場合に、イントロスペクションで得たルートを数えます。

`guren codegen` は、`--introspect` を付けない限りルートファイルを読みます。Vite プラグインが編集のたびに codegen を実行し、`guren check`、`doctor`、`guren gate` もデフォルトの codegen の出力を基準にしているからです。`--introspect` を付けると、どのルートがどの順で存在するかはアプリが決め、各ルートはルートファイルの Zod から描画します。すべてのルートがルートファイルとそのモジュールから来るアプリでは、生成物はバイト単位で一致します。例外は、同じ名前のルートが 2 つあり、`createApp({ modules })` のモジュールの並びがディレクトリの並びと違う場合です。

アプリだけが登録するルートはスキーマの型なしで追加され、そのルートを挙げた警告が出ます。そのルートのエージェントツールはマニフェストから取ります。2 つのルートが同じツール名を持つ場合は、実行時と同じく、アプリが先に登録したほうを残します。この出力が残るのは、フラグなしで次に codegen が実行されるまで(Vite の監視によるものも含む)です。エージェントツールがすべて provider から来るアプリでは、`check` と `doctor` が書き出された `.guren/agents.gen.ts` を古いものとして報告し、案内に従って `guren codegen` を実行すると削除されます。ルートファイル自身もツールを導出するアプリでは、`check` と `doctor` はファイルがあるかどうかしか見ないので、追加されたツールについては何も報告しません。アプリをイントロスペクションできない場合と、`--routes` が `check` の見つけるエントリとは別のファイルを指している場合は、理由を表示したうえでルートファイルから生成します。

```bash
bunx guren codegen --introspect
```

`guren spec:generate` と `check --spec` は、常にルートファイルを読みます。ビューはコミットされるもので、`guren gate` はイントロスペクションせずにプロセス内でビューを生成し直します。そのため、マニフェストから書いたビューは、そこで差分として報告されてしまいます。

### エージェントに公開したルート

`.agent()` メタデータを宣言したルート([ルーティング](./routing.md)を参照)は、`check` の検査対象になり、`audit` ではより厳しく扱われます。ルールは通常の `check` スイートで実行され、該当するルートがあるときだけ有効になります。エージェント公開ルートがないアプリでは指摘は出ず、コントローラの走査も行いません。

`check` が **失敗**(fail)にするもの:

| 指摘のキー | ルール |
|---|---|
| `agent-route-name:*` | エージェントのメタデータを宣言しているのに `.name()` がない。ツール名はツールを識別する名前そのものなので、名前のないルートはツールになれない。 |
| `agent-route-tool-name:*` | ツール名(`agent.toolName` またはルート名)が MCP の文法 `^[A-Za-z0-9._-]{1,128}$` に合っていない。クライアントは、そのツールだけでなくツール一覧全体を拒否する。 |
| `agent-route-reserved-name:*` | フレームワークが予約しているツール名を使っている。`guren_preflight` は、MCP エンドポイントが自分で追加するメタツールの名前。この名前を使ったルートは、まったく公開されない。 |
| `agent-route-portable-name:*` | (警告、参考扱い) MCP としては正しいツール名だが、文法 `^[A-Za-z0-9_-]{1,64}$` に合っていない。この文法は Claude と OpenAI のツール API が課しているもので、Claude Managed Agents は MCP ツールにも適用する。これらのクライアントは、ツールを何も言わずに読み飛ばす。`agent.toolName` に、どのクライアントでも通る綴り(`posts_index`)を設定すること。参考扱いなので、`check --ci` と `guren gate` はこの指摘では失敗しない。 |
| `agent-route-duplicate:*` | 2 つ以上のルートが同じツール名になる。 |
| `agent-route-authorization:*` | 読み取り専用ではないツールなのに、ミドルウェアチェーンに認可の capability がなく、コントローラアクションでも `this.authorize(...)` を呼んでいない。**認証は認可の代わりにならない**。`this.auth.userOrFail()` や API トークンの確認だけの場合は、専用のメッセージで報告される。 |

`check` が **警告**(warn)にするもの:

| 指摘のキー | ルール |
|---|---|
| `agent-route-output:*` | ルートに `output` スキーマも `resource` ヒントもないので、導出したツールが出力の形を示せない。読み取り系だけでなく、書き込み系のツールにも適用する。 |
| `agent-route-inertia:*` | アクションが `this.inertia(...)` で応答していて、出力の形も宣言していない。このツールは、ページがコンポーネントに渡した内容をそのまま返すことになる。このルートでは、上の指摘の代わりにこちらが報告される。 |
| `agent-route-input:*` | ボディを持つメソッドのルートに `body` スキーマがなく、導出される入力スキーマがパスとクエリだけで組み立てられる。インラインハンドラでは、このスキーマがリクエスト時の検証そのものでもあるので、送られてきた内容を検証するものが何もないことになる。 |
| `agent-route-annotation:*` | 読み取り専用のツールなのに、アクションがレコードを削除・更新・force-write している。更新系のメソッドに `readOnlyHint: true` を明示した場合と、デフォルトで読み取り専用になる GET・QUERY の場合のどちらも対象。読み取り専用であれば認可ルールが適用されなくなるので、アクションの中身と照らし合わせて検査する。 |
| `agent-route-authorization:*` | 判定までたどり着けなかった。ハンドラがインライン関数の場合か、コントローラアクションが check の読み取り対象に入っていない場合に出る。 |
| `agent-route-controller-collision:*` | 同じ名前のコントローラクラスが 2 つあり、その一方をエージェント公開ルートが使っている。コントローラ本体から導いた判定が、もう一方のクラスのものになっているおそれがある。 |
| `agent-route-controller-unreadable:*` | コントローラのファイルを読み取れなかった。そのファイルで定義されたアクションを使うエージェント公開ルートは、本体をまったく見ないまま検査されたことになる。 |
| `agent-route-controller-unparsed:*` | コントローラのファイルを構文解析できなかった。そのファイルで定義されたアクションを使うエージェント公開ルートは、本体を見ないまま検査されている。そのファイルのクラス名を指すルートが、同名のクラスを宣言した別のファイルと照合されることがあり、そのときは名前の衝突が報告されない。 |
| `route-graph` | ルートファイルの読み込みに失敗したので、ルート契約のチェックもエージェントルートのチェックも実行されなかった。 |

`audit` は、同じルートに対して次のルールを追加します。

- 通常のルートでは警告になるボディ検証の指摘が、エージェント公開ルートでは **失敗** になります。キーは `validation:*` のままなので、既存の `config/audit.ts` のエントリはそのまま効きます。
- `agent-annotation:*` は、レコードを削除・更新・force-write するアクションに `destructiveHint: false` が宣言されている場合と、アクション本体が読めずにその宣言を検査できなかった場合に警告します。
- `controller-unreadable:*` は、コントローラのファイルを読み取れなかった場合に警告します。そのファイルで定義されたアクションについては、上のルールのどれも本体を見られていないからです。
- `controller-unparsed:*` は、コントローラのファイルは読み込めたものの構文解析できなかった場合に警告します。そのファイルのアクションの本体は、上のルールからは見えません。さらに、クラス名だけでそのファイルのクラスに対応づけられたルートは、同名のクラスを宣言した別のコントローラファイルの本体で判定され、`controller-name-collision:*` も出ません。

誤検出は、対象の行かその直前の行に `// guren-audit-ignore` を置けば抑制できます。

```ts
// guren-audit-ignore -- ドキュメント用のサンプル値
const apiKey = 'example-not-a-real-key'
```

ルート単位・モデル単位の指摘(`authz:*`、`policy:*`、`validation:*`、`agent-annotation:*`、`mass-assignment:*`、`hidden-columns:*`)には、コメントを付けられる行がありません。ルートレジストラを実行し、モデルを検査して得られる指摘だからです(`policy:*` だけは、直す場所がアクションなので、その上のコメントに置いたマーカーも受け付けます)。これらを無視するには、`config/audit.ts` に指摘の `key`(`--json` の出力からそのままコピーできます)と、省略できない `reason` を書きます。

```ts
// config/audit.ts
export default {
  ignore: [
    { key: 'authz:POST /webhooks/stripe', reason: 'コントローラでHMAC署名を検証済み' },
  ],
}
```

無視した指摘もレポートには残り、`status: "ignored"` と `ignoreReason` が付きます。何も言わずに握りつぶされる指摘はありません。`key` や `reason` が抜けているエントリと、どの指摘にも一致しなかったエントリは、それ自体が警告として報告されます。そのため、使われなくなったルールが気づかれないまま残ることはありません。

`config/audit.ts` で無視できる指摘は、ソースの行を持たないもの、つまり上のルート単位・モデル単位の指摘に限られます。行に結び付く指摘(ハードコードされた認証情報、生 SQL、無効にされたセキュリティのデフォルト設定)には、すでに `// guren-audit-ignore` という方法があります。こうした指摘を対象にしたエントリは適用されず、インラインコメントを使うよう促す警告になります。目に付きにくい 2 つ目の抑制方法ができてしまうのを避けるためです。

### インプロセスエージェント

`@guren/plugin-ai` の `Agent` のサブクラスには、`check` の専用ルールがあります。これも該当するクラスがあるときだけ有効になり、ないアプリには何も追加されません。対象は、このパッケージの `Agent`(名前付き import でも namespace import でもかまいません)を継承したクラスと、そのクラスをさらに継承したクラスだけです。親クラスは、識別子の綴りではなく、そのファイルの import を解決して判定します。`@guren/plugin-agents` の永続エージェントは対象外で、別の場所にある同じ名前のクラスを親と取り違えることもありません。

`check` が **失敗**(fail)にするもの:

| 指摘のキー | ルール |
|---|---|
| `ai-agent-tool-underived:*` | リテラルで書かれた `appTools([...])` の名前を、どの `.agent()` ルートも導出していない。`as()` が例外を投げる。 |
| `ai-agent-tool-unscoped:*` | クラスの `static scopes`(自分で宣言したものか継承したもの)がその名前を許可していない。判定は RFC 0016 の文法(`tool:<name>`、`tools:<prefix>.*`、`tools:read`、`tools:*`)に従う。`scopes` のないクラスは何も許可しない。 |
| `ai-agent-scope-malformed:*` | `static scopes` に文法に合わないエントリ(`tickets_show` のような名前だけのものなど)がある。そのエントリは何も許可せず、`as()` が例外を投げる。 |
| `ai-agent-audit-duplicate` | `aiPlugin({ audit })` と `mcpPlugin({ audit })` の両方で監査ログを設定している。最初のツール呼び出しで例外になる。各プラグインは自分のサーフェスへの呼び出しを自分のキューで承認待ちにするので、承認キューが 2 つあること自体は報告しない。 |

`check` が **警告**(warn)にするもの:

| 指摘のキー | ルール |
|---|---|
| `ai-agent-plugin-missing` | `Agent` のサブクラスがあるのに、プロジェクト内のどのソースファイルも `aiPlugin()` を呼んでいない。`appTools()` を呼ぶエージェントは最初の `as()` で例外になり、`queue()` と監査ログにもプラグインが必要になる。根拠が「呼び出しが見つからないこと」なので、バインドされていないセッション設定と同じく警告にしている。 |
| `ai-agent-app-tools-unreadable:*` | `appTools()` の引数が文字列リテラルの配列ではない(スプレッド、変数、計算された要素)。名前を検証できないので、合格にもしない。 |
| `ai-agent-scopes-unreadable:*` | `static scopes` がリテラルの配列ではないので、名前をスコープと照らし合わせていない。 |
| `ai-agent-tools-unverified:*` | ルートグラフの読み込みに失敗したので、名前を導出済みのツールと照らし合わせていない。 |

`audit` は、エージェントの `tools()` が `appTools()` のスプレッドと一緒に返すローカルツールを、専用の見出しと `--json` の `aiLocalTools` にすべて列挙します。ローカルツールはクロージャの権限で動き、スコープ、ポリシー、承認、監査ログのどれも通りません。`ai-local-tool-write:*` は、ツールの `execute` が Model の書き込み(`create`、`update`、`delete`、`save`)を呼んでいて、そのモデルのテーブルを `.agent()` ルートのアクションも使っている場合に警告します。その場合は、ルートのほうをエージェントに渡してください。`ai-local-tools-unreadable:*` は、`tools()` が返すものが、スキャンで中身をすべて列挙できるオブジェクトリテラルではない場合に警告します。どちらの指摘もソースの行を指すので、`// guren-audit-ignore` で抑制できます。

### アーキテクチャ境界

プロジェクトルートに `guren.arch.ts` を置けば、フラグを付けなくても `guren check` が境界を検証するようになります。

```typescript
// guren.arch.ts
import { defineArchRules } from '@guren/cli/arch'

export default defineArchRules({
  layers: {
    domain: 'app/Domain/**',
    http: 'app/Http/**',
  },
  rules: [
    // ドメインロジックはHTTP層に依存してはいけない
    { from: 'domain', disallow: ['http'] },
    // コントローラはORMを直接使わずModel経由でクエリする
    { from: 'http', disallowPackages: ['drizzle-orm'] },
  ],
})
```

各ルールの `from` と `disallow` には、上で定義したレイヤー名か、インラインの glob を指定します。既存のコードベースに新しい境界を入れるときは、`severity: 'warn'` から始めて、違反がなくなったら外す(デフォルトの `'fail'` に戻す)と安全です。

ルールは実行時の依存を解析します。型だけの import(`import type { X } from '...'`・`export type { X } from '...'`・型の位置にある `import('...').X`)はコンパイルで消えるので、デフォルトでは対象外です。DTO や props の interface をレイヤーをまたいで共有しても、たいていは問題にならないからです。型のレベルでも守りたい境界には、ルール(またはルール全体)に `includeTypeImports: true` を指定してください。ルール側の指定が優先されます。

```typescript
rules: [
  // クエリ層への型依存は、実行時依存まであと一歩のリファクタリング距離にある。
  { from: 'frontend', disallow: ['queries'], includeTypeImports: true },
]
```

`includeTypeImports` は、`guren.arch.ts` に宣言したルールにだけ効きます。`modules/` ディレクトリがあると自動で有効になる、設定不要のモジュール境界ルールにはこのオプションがなく、常に実行時の import だけを解析します。

AI コーディングエージェントや大きなアプリで使いやすくするためのフラグが 2 つあります。

```bash
bunx guren check --arch      # アーキテクチャチェックのみ実行 — 編集フック向けの高速パス
bunx guren check --changed   # main とのマージベースからの変更ファイルのみを検査対象にする
```

プロジェクト内のファイルに解決できない import は、失敗ではなく警告として報告されるので、解決できないパスのせいでビルドが止まることはありません。

## アプリケーションモジュール

ルートが数十を超えてきたら、フラットな `app/`・`routes/`・`db/schema.ts` にすべてを詰め込むのをやめて、`guren make:module` でアプリの一部を独立したモジュールとして切り出せます。

```bash
bunx guren make:module Billing
```

`modules/billing/{index.ts, routes.ts, db/schema.ts}` が生成され、配線も自動で済みます。`db/schema.ts` には `export * from '../modules/billing/db/schema'` が、`src/app.ts` には `billingModule` の import と `createApp({ modules: [...] })` への登録が追加されます。

ルートの `db/schema.ts` が、drizzle に渡すスキーマオブジェクト(`export const schema = { posts, users }` のように、名前が `schema` であるか `typeof` で参照されているもの)を持っていることがあります。その場合はモジュール側にも `export const billingSchema = {}` が生成され、ルートのオブジェクトがそれを展開します(`{ posts, users, ...billingSchema }`)。モジュールのテーブルは `modules/billing/db/schema.ts` に宣言し、1 つずつ `billingSchema` に並べてください。どちらかのオブジェクトからテーブルが抜けていると、`guren check` が報告します。ルートのオブジェクトが並べても展開もしていないモジュールのテーブルも、報告の対象です。

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

`create-guren-app` で作ったアプリには、AI エージェント向けのハーネスが最初から入っています。雛形を作るときに使うエージェント(Claude Code・Codex・Cursor・GitHub Copilot・OpenCode)を選ぶと、それぞれのエージェントがそのまま読み込める形でファイルがインストールされます。非対話の環境では `--agents codex,cursor` のように指定し、`--agents none` で入れないこともできます。

選んだエージェントごとに、次のものが生成されます。

- **Claude Code**: プロジェクトガイドの `CLAUDE.md`、`.claude/` 配下の検証済みの API ルール・スキル・サブエージェント、開発サーバーの MCP エンドポイントを指す `.mcp.json`(エンドポイントは、生成された `dev` スクリプトの `GUREN_MCP=1` で有効になります)、そしてフィードバックループを作る hooks です。セッションの開始時に `guren context` のプロジェクトマップが読み込まれ、ルート・コントローラ・モデル・スキーマ・ページを編集すると `guren check` が自動で再実行されて、失敗がその場でコーディングエージェントに伝わります。さらに、コミットしていない変更を残したままターンが終わると、`Stop` hook が `guren gate` を実行し、失敗したステージの指摘を添えて停止を 1 回だけブロックします。これで、修正を CI まで持ち越さず、同じターンの中で済ませられます。
- **Codex・Cursor・GitHub Copilot・OpenCode**: プロジェクトガイドの `AGENTS.md` と、`.agents/rules/`・`.agents/skills/` 配下の同じルールとスキル(スキルはエージェント共通の SKILL.md 標準形式)です。加えて、Cursor には Cursor 形式のルール(`.cursor/rules/guren-*.mdc`)、Copilot にはパスごとの instructions(`.github/instructions/guren-*.instructions.md`)、Codex にはハーネス自身のコマンドを承認なしで実行できるようにする許可リスト(`.codex/rules/guren.rules`)が生成されます。MCP クライアントの設定は、各ツールが読む場所(`.codex/config.toml`・`.cursor/mcp.json`・`.vscode/mcp.json`・`opencode.json` の `mcp` エントリ)に書き出されます。

  Cursor と Codex には、`guren gate` を実行する stop hook も入ります(`.cursor/hooks.json` + `.cursor/hooks/gate-on-stop.ts`、`.codex/hooks.json` + `.codex/hooks/gate-on-stop.ts`)。コミットしていない変更を残してターンが終わり、どれかのステージが失敗すると、Cursor には指摘が自動の follow-up メッセージとして届き(回数の上限は `loop_limit`)、Codex は停止を 1 回ブロックして指摘を返します(Codex の project hook は、`/hooks` で一度信頼(trust)すると動きます)。Claude Code と同じループです。同じ hook は、`guren plan:next` で印を付けた計画のステップも検証し(RFC 0030)、そのステップの検証が通る(`verified` になる)まで、最大 3 回指摘を差し戻します。

  hook は、自分がインストールされたアプリにゲートをかけます。そのため monorepo の中のアプリでは、そのアプリのツリーだけが対象になります。Claude Code の hook はセッションがいる checkout にゲートをかけるので、途中で worktree に入った場合は、その worktree のツリーが対象です。Cursor は `.cursor/hooks.json` をワークスペースのルートから読むので、アプリは単独のワークスペースとして開いてください。Cursor は設定によっては `.claude/settings.json` の hook も読み込みますが、その場合 Claude 用の hook は Cursor 側に処理を譲るので、ゲートは 1 回しか走りません。Copilot と OpenCode には出力をエージェントに戻せるターン終了 hook がなく、編集時の hook はどのエージェントでも実行されません。そのため `AGENTS.md` で、セッション開始時に `guren context`、編集後に `guren check`、変更が終わったと言う前に `guren gate` を実行するよう指示しています。

ハーネスが書き出すファイルの仕様は、各エージェントの公式ドキュメントで確認できます。Claude Code については [`CLAUDE.md` と `.claude/rules/`](https://code.claude.com/docs/ja/memory)、[スキル](https://code.claude.com/docs/ja/skills)、[サブエージェント](https://code.claude.com/docs/ja/sub-agents)、[hooks](https://code.claude.com/docs/ja/hooks)、[MCP](https://code.claude.com/docs/ja/mcp)、[`settings.json`](https://code.claude.com/docs/ja/settings) のページです。ほかのエージェントについては、[`AGENTS.md`](https://agents.md/) の形式、[Agent Skills](https://agentskills.io/) の標準、Cursor の [Rules](https://cursor.com/ja/docs/rules) と [Hooks](https://cursor.com/ja/docs/hooks)、GitHub Copilot の[リポジトリのカスタム指示](https://docs.github.com/ja/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions)、OpenCode の [Rules](https://opencode.ai/docs/rules/) を参照してください。

### アプリを作る前に: カタログから Guren のスキルを入れる

上のハーネスはアプリの `@guren/cli` に入っているので、アプリを作るまでは存在しません。それより前、Guren を知らないエージェントが空のディレクトリにいる段階のために、Guren は導入用のスキルを 2 つ、[`gurenjs/agent-skills`](https://github.com/gurenjs/agent-skills) からエージェントのカタログに公開しています。

```bash
# Claude Code
claude plugin marketplace add gurenjs/agent-skills
claude plugin install guren@gurenjs --scope user

# Cursor・Codex・Copilot・OpenCode・Gemini CLI など(Agent Skills CLI)
npx skills add gurenjs/agent-skills
```

インストール先はユーザースコープです。これらのスキルはプロジェクトができる*前*の段階で使うもので、何を作るにしても同じ 2 つだからです。プロジェクトスコープにすると、そのときたまたまいたリポジトリの設定に書き込まれてしまい、すでにハーネスが入っているアプリの共同作業者にまで導入用のスキルを配ることになります。このプラグインは [Agent Plugins v1](https://agent-plugins.org) にも準拠しているので、ルートの `plugin.json` を読むクライアントなら、リポジトリから直接インストールできます。

中身は `guren-new-app`(Guren を説明し、`bunx create-guren-app` で雛形を作って、アプリ側に引き継ぐ)と `guren-harness`(`bunx guren agent:init --target <agents>` を実行し、`guren context` → 編集 → `guren check` → `guren audit` のループを説明する)の 2 つです。ハーネスのルールやスキルは、あえてコピーしていません。それらはアプリ自身の CLI が入れるもので、常にアプリのバージョンと揃っています。このリポジトリはリリースのたびに `packages/cli/templates/agent-catalog/` から生成されるので、変更はそちらに送ってください(`gurenjs/agent-skills` には送らないでください)。

| コマンド | 説明 | 例 |
|---------|------|-----|
| `agent:init` | 選んだエージェント向けのハーネスを既存のアプリに入れる(既存のファイルはスキップ、`--force` で上書き) | `bunx guren agent:init --target codex,cursor` |
| `agent:sync` | フレームワークが管理するファイル(ルール・スキル・サブエージェント・hooks)を、ディスク上で見つかったすべてのエージェントの分まとめて最新版にする | `bunx guren agent:sync` |

`agent:init --target` には `claude`(デフォルト)・`codex`・`cursor`・`copilot`・`opencode`・`all` を指定できます。`agent:sync` は利用者が持つファイル(`CLAUDE.md`・`AGENTS.md`・`.claude/settings.json`・各 MCP クライアントの設定)を上書きしないので、フレームワークを更新してもカスタマイズは残ります(削除した利用者側のファイルは作り直されます)。MCP の設定がすでにある場合、`agent:init` はファイルを上書きせず、手で追記するためのスニペットを表示します。

フレームワークが管理するファイル(ルール・スキル・サブエージェント・hooks)は、`agent:sync` が上書きします。それがこのコマンドの役目なので、プロジェクト固有のルールは配布されたファイルに書き足さず、別の名前の自分のファイルとして置いてください。上書きは必ず画面に表示されます。最新版と同じファイルはスキップし、内容が違っていたファイルは「置き換えた」とはっきり示します。先に `agent:sync --dry-run` を実行すれば、ファイルを一切変えずに、何が書き込まれ、何が置き換えられ、何が削除候補になるかを確認できます。`agent:init` も `--dry-run` を受け付けるので、`--force` のプレビューとして使えます。

リリースでフレームワークのルールやスキルの名前が変わったり削除されたりしても、古いファイルは配布先のルートにすべて残ったままになります。特に Cursor と Copilot は、古い `.cursor/rules/guren-*.mdc` / `.github/instructions/guren-*.instructions.md` を glob で読み込み続けます。`agent:sync` は、フレームワークが管理する場所にあって今のハーネスに含まれないファイルを一覧にし、`agent:sync --prune` を付けるとそれらを削除します。

削除の対象は、常に**名前**で決まります。

- ルールのルート(`.claude/rules/`、`.agents/rules/`): ハーネスが配布している(または以前配布した)ルールのファイル名だけ
- 各エージェント形式のルール: `guren-` プレフィックスのものだけ
- スキルのルート(`.claude/skills/`、`.agents/skills/`): ハーネスが配布している(または以前配布した)スキルのディレクトリだけ

配布されたルールの隣(サブディレクトリを含む)に置いた自作のルールファイルや、自分で追加したスキル(`npx skills add` や Agent Plugins のクライアントが同じディレクトリに入れたものを含む)は、一覧にも出ず、削除もされません。例外は、ハーネス自身が配布している名前とぶつかった場合だけです。スキルなら `dev-workflow`・`db-manage`・`scaffold`・`feature`・`guren-api`・`plugin-authoring`・`agent-interface`・`ai-agent`・`github-projects`・`plan-write`・`plan-implement`、ルールならエントリードキュメントに載っているファイル名(大文字と小文字は区別しません)が該当します。Cursor と Copilot では名前の一覧ではなくプレフィックスで判定するので、`guren-` で始まるファイルが**すべて**該当します。Cursor や Copilot の自作ルールには別のプレフィックスを付けておき、`--prune` の前には一覧を確認してください。

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

`--target` には `docker` / `fly` / `railway` / `all` を指定できます。書き出すファイルがすでにあると、コマンドは該当するファイルをすべて一覧にして、1 つも書き込みません。上書きしたいときは `--force` を付けてください。

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

起動したアプリケーションに[監査ログ](./agent-interface.md#監査ログ)が設定されていれば、この呼び出しも `surface: 'cli'` として記録されます。書き込み先も引数のマスクも MCP からの呼び出しの記録とまったく同じで、同じファイルに並びます。この経路での呼び出しは `--as` で指定したユーザーとして、何も検証されずに実行されるので、あとから確認できるようにしておく意味があります。監査ログを設定していないアプリケーションでは何も記録されず、呼び出しの動きも変わりません。

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

`-n` はフィルタを適用した**あと**に効きます。つまり `--denied -n 50` は「直近 50 件の拒否」で、「直近 50 件のうちの拒否」ではありません。レコードは、シンクを設定したあとの分しか残りません。監査ログの設定は任意なので、ログが見つからない場合は、追加すべき設定行を表示します。[エージェントインターフェース: 監査ログ](./agent-interface.md#監査ログ)も参照してください。

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

```bash
# マイグレーションを実行
bunx guren db:migrate

# 実行せずに内容だけを表示
bunx guren db:migrate --dry-run

# 結果を JSON で出力
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

次のオプションは、どの `make:*` / `add` コマンドでも同じように動きます。

- `--force` / `-f`: 既存のファイルを上書きする
- `--dry-run`: 生成する内容を表示するだけで、書き込まない(予定)
- `--cwd <path>`: 指定したパスのワークスペースでコマンドを実行する(デフォルトはカレントディレクトリ)

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

## トラブルシューティング
- `command not found: bunx`: Bun が古いのかもしれません。サポートの基準になっている Bun 1.4.2 をインストールしてください。
- `Error: Port already in use`: 開発サーバーのポート(デフォルトは 3333)がほかで使われています。`.env` の `PORT` を変えてから再起動してください。
- `Database connection failed`: デフォルトのデータベースは SQLite(`./data/guren.db`)です。PostgreSQL を使う場合は、`.env` の `DATABASE_URL` を確認してください。

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

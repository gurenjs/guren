# CLI リファレンス

Guren には 2 つの CLI が付属します。

- 既存プロジェクト内でコントローラー/モデル/ビュー生成やユーティリティを実行する `bunx guren`
- 新規アプリをスキャフォールドする `bunx create-guren-app`

## 基本的な使い方

```bash
# グローバルインストール不要。プロジェクトルートでそのまま実行
bunx guren --help
```

コマンドは `bunx guren make:controller UserController` のようなサブコマンド形式です。

## 高レベルスキャフォールド

低レベルな `make:*` ではなく、標準構成をまとめて導入したい場合は `bunx guren add ...` を使います。

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
bunx guren add broadcasting
bunx guren add schedule
```
> **Golden path:** まず `bunx guren add auth` と `bunx guren add resource` から始め、アプリの成長に応じて他の機能を追加してください。

```bash
bunx guren plugin @acme/guren-plugin-audit
```

`plugin`（`add plugin` としても利用可能）は、依存が未インストールの場合に `bun add` でインストールし（`--no-install` でスキップ可能）、プラグインが宣言するGurenバージョン互換性を検証した上で（`--ignore-compatibility` で無視可能）、Providerを `src/app.ts` に自動登録します。プラグインが `gurenPlugin` マニフェストで宣言した設定スタブや環境変数キーも適用されます。`--force` は公開済みファイルの上書きに使います。

これらのコマンドは `src/app.ts` を更新し、対応する provider/runtime ファイルを生成します。

`bunx guren add admin` は次を生成します:

- `app/Http/Controllers/Admin/AdminDashboardController.ts`
- `resources/js/pages/admin/Dashboard.tsx`
- `routes/admin.ts`（`routes/web.ts` がある場合は自動配線）

ダッシュボードは**既定で認証必須**です。`routes/admin.ts` が `/admin` に
`requireAuthenticated({ redirectTo: '/login' })` を付与し、コントローラーでも
`this.auth.userOrFail()` を呼びます。`make:feature --public` が変更系アクション
だけを対象にするのに対し、ここでの `--public` はダッシュボード全体を公開します:

```bash
bunx guren add admin --public
```

`add auth` より先に `add admin` を実行しても構いません。その場合もガードは有効で、
認証が未設定のアプリにはサインイン済みユーザーが存在しないため、すべてのリクエストが
`/login` にリダイレクトされます。`/login` は `bunx guren add auth` を実行して初めて
存在するルートです。実際に使えるダッシュボードにするには先に認証を追加するか、
`--public` を付けて後から独自のチェックを実装してください。

`add admin` はフルスタックアプリ専用です。ダッシュボードは Inertia ページなので、
`api` ブループリントで生成したアプリ（`@guren/inertia-client` 依存も、web ルート
エントリ（`routes/web.ts` または `routes/web.js`）も持たない）では、型検査を通らない
コントローラーとどこにもマウントされないルートファイルを書く代わりに、コマンドが
理由を示して中断し何も生成しません。管理用のエンドポイントは `make:controller` で
生成し、`routes/api.ts` に登録してください。

`add auth` も同じ理由でフルスタックアプリ専用で、同じ2つのシグナルを見て中断します。
同じスキャフォールドを生成する `make:auth` も同様です。auth は `db/schema.ts` への
パッチとマイグレーション生成も行うため、中断は最初のファイル書き込みだけでなく
それらすべてより前に起こり、アプリは元のまま残ります。トークンベースのAPIに
するには、`@guren/core` の `createBearerTokenMiddleware` で `routes/api.ts` を
保護し、`createApiToken` でトークンを発行してください
（[APIトークンガイド](./api-tokens.md)参照）。

`add resource` も同じ2つのシグナルを見て、同じ理由で中断します。React のページ
コンポーネントと Inertia レスポンスを返すコントローラーを生成するためです。中断は
同様に、`db/schema.ts` へ追記されるはずだったテーブルよりも前の時点で起こります。
同じスキャフォールドに直接到達する `make:feature` も同様に中断します。JSON を
返すコントローラーは `make:controller` で生成し、`routes/api.ts` に結線して
ください。

`make:controller` は同じ2つのシグナルを読みますが、中断ではなく適応します。
API専用と判定されたアプリでは、生成されるコントローラーは Inertia ページではなく
JSON(`this.json(...)`)を返すため、そのまま型検査を通り、`routes/api.ts` に
そのまま結線できます。シグナルが API専用と確認できない場合は通常の Inertia
テンプレートが生成されます — `@guren/inertia-client` をインストールすれば
元に戻ります。

`make:view` は上記のスキャフォールドと同様、同じシグナルで中断します。ページには
適応できる JSON 版が存在せず、そのアプリにはページを描画する手段がないためです。
`guren codegen`(`bun run dev` が自動実行します)はそうしたコンポーネントを
`.guren/pages.gen.ts` に取り込まず除外します — このファイルは API専用アプリが
インストールしない `@guren/inertia-client` を import するためです。つまり中断は
`typecheck` の破壊を防ぐためではなく、原因となったコマンドの時点でそれを伝える
ためのものです。API アプリをフルスタック化するときは、先に
`@guren/inertia-client` をインストールすれば再び使えるようになります。

`add resource` は、アプリの形がどうであれ、パッチ対象の2つのファイルがそこにあることも
必要とします。テーブル定義を `db/schema.ts` に追記し、CRUD ルートを `routes/web.ts` に
登録するため、両方が既に存在している必要があり、さらに該当ルートが未登録の場合は
`routes/web.ts` がパッチ可能なルートレジストラをエクスポートしている必要があります。
いずれかが欠けている場合、コマンドはどれが足りないかを示して何も生成しません。生成物だけを
残したまま、登録されなかったルートのためのテーブルが `db/schema.ts` に追記された状態を
作らないためです。2つのパッチなしでファイルだけが欲しい場合は `bunx guren make:feature`
を使ってください。貼り付け用のルートブロックを出力し、テーブル定義を追記すべきスキーマ
ファイルを案内します。

## 主要コマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `key:generate` | 新しい `APP_KEY` 値を生成。`--write` で `.env` に保存 | `bunx guren key:generate --write` |
| `deploy` | Docker/Fly.io/Railway/Vercel 向けデプロイ設定ファイルを生成 | `bunx guren deploy --target all --app my-app --port 3333` |
| `make:controller <Name>` | `app/Http/Controllers` にコントローラーを生成(API専用アプリでは Inertia ページの代わりに JSON を返す) | `bunx guren make:controller PostController` |
| `make:model <Name>` | 最小のモデルクラスと型定義を `app/Models` に生成（`db/schema` から `camelCase(Name)s` を import） | `bunx guren make:model Post` |
| `make:view <path>` | `resources/js/pages` に React コンポーネントを生成(API専用アプリでは中断) | `bunx guren make:view posts/Index` |
| `make:auth` | ログイン/ログアウト・新規登録・パスワードリセットのコントローラー、プロバイダー、ビュー、マイグレーション、シーダー、ルートをスキャフォールド（`--minimal` で登録・パスワードリセットを省略、`--verify` でメール確認も追加、`--oauth <providers>` でカンマ区切りのプロバイダー向け OAuth ログインボタンも追加、`--oauth-only` でパスワードログインを完全に外して OAuth のみにする） | `bunx guren make:auth --oauth github,google` |
| `make:middleware <Name>` | `app/Http/Middleware` にミドルウェアを生成 | `bunx guren make:middleware Auth` |
| `make:seeder <Name>` | データベースシーダーファイルを生成 | `bunx guren make:seeder UserSeeder` |
| `make:job <Name>` | キュー可能なジョブクラスを生成 | `bunx guren make:job SendEmail` |
| `make:event <Name>` | イベントクラスを生成 | `bunx guren make:event UserRegistered` |
| `make:listener <Name>` | イベントリスナークラスを生成 | `bunx guren make:listener SendWelcomeEmail` |
| `make:notification <Name>` | 通知クラスを生成 | `bunx guren make:notification InvoicePaid` |
| `make:mail <Name>` | メールクラスを生成 | `bunx guren make:mail WelcomeEmail` |
| `make:command <Name>` | `app/Console/Commands` にコンソールコマンドを生成。`--command <name>` で呼び出し名を指定。`src/console.ts` への登録が必要（[コンソールコマンドガイド](./console.md)参照） | `bunx guren make:command SendDigest --command reports:digest` |
| `make:policy <Name>` | 所有者ベースのデフォルトを備えた認可ポリシーを `app/Policies` に生成 | `bunx guren make:policy Post` |
| `make:validator <Name>` | Zodバリデーションスキーマ(ルートパラメータ・一覧クエリ・ペイロード)を `app/Http/Validators` に生成。`--fields` は `make:feature` と同じ構文 | `bunx guren make:validator Post --fields "title:string,body:text"` |
| `make:adr "<Title>"` | アーキテクチャ意思決定を採番付きファイルとして `docs/adr/` に記録(リンク可能なfrontmatter付き)。`--entity <Model>` で `entities:`/`related:` を自動補完 | `bunx guren make:adr "Billing cycle is end-of-month" --entity Invoice` |

> **Note:** `make:*` は既存ファイルを上書きしません。必要なら `--force` を付けてください。

## 検査・監査コマンド

リリース前のアプリ検証に使えるコマンドです。AIコーディングエージェント向けにも設計されています(`--json` で機械可読な出力になります)。

| コマンド | 説明 | 例 |
|---------|------|-----|
| `check` | ルート・コントローラ・ページ・モデル間の整合性（`routes/` 配下の各ファイルがエントリのレジストラから、モジュールの `routes/` 配下は各モジュール自身のレジストラから実際に呼ばれているかを含む）に加え、docリンク・スペックビューの鮮度・アーキテクチャ境界を検証 | `bunx guren check --json` |
| `audit` | セキュリティ監査: 変更系ルートのバリデーション/認証の欠如、文字列補間付き生SQL、ハードコードされた認証情報、無効化されたセキュリティ既定値、mass assignment 設定、`hidden` 未登録の機微カラム、リクエストのホストから組み立てられたメール内リンクを検査 | `bunx guren audit --json` |
| `doctor` | プロジェクトの健全性レポート(環境変数・設定・生成ファイル)と次のアクション | `bunx guren doctor --next` |
| `context [Entity]` | プロジェクトコンテキストマップ。エンティティ名を渡すと1モデルのすべて — テーブル・リレーション・スキーマ付きルート・Props付きページ・Resource・Policy・紐付きdocs — を出力(同名モデルは `--module` で解決、`"app"` はプロジェクトルート) | `bunx guren context User --json` |
| `docs:graph` | OKF docsのリレーショングラフ。文書・エンティティ・コードパスがノード、検証済みリレーションがエッジ。`--entity <Model>` / `--path <file>` で近傍に絞り、リネーム前に「これを統べるdocsはどれか」を照会 | `bunx guren docs:graph --path app/Http/Controllers/PostController.ts` |
| `spec:generate` | `docs/spec/` の導出スペックビュー(ER図・ドメインモデル・画面一覧・モジュールマップ)を再生成 — 詳細は[スペックアンカード開発](./spec-anchored.md) | `bunx guren spec:generate` |

`audit` は失敗(fail)を検出すると非ゼロの終了コードを返します。
プレーンな `check` は情報提供で、CIをゲートするのは各スイートフラグです
(それぞれのスイートの失敗で非ゼロexit):

```bash
bunx guren audit
bunx guren check --arch    # アーキテクチャ境界(guren.arch.ts + モジュールルール)
bunx guren check --docs    # docリンク: OKF frontmatter(type/entities/related)+ 本文リンク + @docsタグ
bunx guren check --spec    # docs/spec/ が再生成結果と一致するか
```

スイートフラグは併用すると和集合で実行されます。`--changed` はいずれの
スイートも main とのマージベースからの変更ファイルに限定します —
エージェントハーネスのedit hookが使う高速パスです。

名前付きミドルウェアで保護されたルート(例: `router.middleware('auth').group(...)`)は保護済みと認識されます。`/login` や `/register` などのゲストフローは認証チェックの対象外です。

### エージェントに公開したルート

`.agent()` メタデータを宣言したルート([ルーティング](./routing.md)を参照)は、`check` の検査対象になり、`audit` ではより厳しく扱われます。ルールは通常の `check` スイートで実行され、内容によって有効化されます。エージェント公開ルートが存在しないアプリでは findings は生成されず、コントローラの走査も行われません。

`check` が **fail** にするもの:

| Finding key | ルール |
|---|---|
| `agent-route-name:*` | agent メタデータを宣言しているのに `.name()` がない。ツール名はツールの識別子そのものなので、名前のないルートはツールになれません。 |
| `agent-route-tool-name:*` | ツール名(`agent.toolName` またはルート名)が MCP の文法 `^[A-Za-z0-9._-]{1,128}$` から外れている。クライアントは該当ツールだけでなくツール一覧全体を拒否します。 |
| `agent-route-duplicate:*` | 2つ以上のルートが同じツール名に解決される。 |
| `agent-route-authorization:*` | read-only でないツールなのに、ミドルウェアチェーンに認可 capability がなく、コントローラアクションでも `this.authorize(...)` を呼んでいない。**認証は認可ではありません**。`this.auth.userOrFail()` や APIトークンの確認はどちらも認可の代わりにならず、その場合は専用のメッセージで報告されます。 |

`check` が **warn** にするもの:

| Finding key | ルール |
|---|---|
| `agent-route-output:*` | ルートに `output` スキーマも `resource` ヒントもないため、導出されるツールが出力の形を提示できない。読み取り系だけでなく書き込み系のツールにも適用されます。 |
| `agent-route-inertia:*` | アクションが `this.inertia(...)` で応答し、出力の形も宣言していない。そのツールはページがコンポーネントに渡した内容をそのまま返すことになります。このルートでは上の finding の代わりに報告されます。 |
| `agent-route-input:*` | ボディを持つメソッドのルートに `body` スキーマがなく、導出される入力スキーマがパスとクエリだけから組み立てられる。インラインハンドラの場合、そのスキーマはリクエスト時の検証そのものでもあるため、送られた内容を検証するものが存在しないことになります。 |
| `agent-route-annotation:*` | read-only なツールなのに、アクションがレコードを削除・更新・force-write している。変更系メソッドに `readOnlyHint: true` を明示した場合と、既定で read-only になる GET・QUERY の場合の両方が対象です。read-only であること自体が認可ルールの適用を免除するため、アクションの内容と突き合わせて検査されます。 |
| `agent-route-authorization:*` | 判定に到達できなかった。ハンドラがインライン関数であるか、コントローラアクションが check の読み取る対象に含まれていない場合です。 |
| `agent-route-controller-collision:*` | 同名のコントローラクラスが2つあり、その一方をエージェント公開ルートが使っている。コントローラ本体から導いた判定が、もう一方のクラスを指している可能性があります。 |
| `agent-route-controller-unreadable:*` | コントローラのファイルを読み取れなかった。そこに定義されたアクションを持つエージェント公開ルートは、本体を一切参照せずに検査されたことになります。 |
| `route-graph` | ルートファイルの読み込みに失敗したため、ルート契約チェックとエージェントルートチェックのどちらも実行されませんでした。 |

`audit` は同じルートに対して2つのルールを追加します。

- 通常のルートでは warning になるボディ検証の finding が、エージェント公開ルートでは **failure** になります。key は `validation:*` のままなので、既存の `config/audit.ts` のエントリはそのまま効きます。
- `agent-annotation:*` は、レコードを削除・更新・force-write するアクションに `destructiveHint: false` が宣言されている場合と、アクション本体を読み取れずその宣言を検査できなかった場合に warn します。
- `controller-unreadable:*` は、コントローラのファイルを読み取れなかった場合に warn します。そこに定義されたアクションについては、上記のルールがどれも本体を参照できていないためです。

誤検出は、対象行またはその直前の行に `// guren-audit-ignore` を置くことで抑制できます:

```ts
// guren-audit-ignore -- ドキュメント用のサンプル値
const apiKey = 'example-not-a-real-key'
```

ルートレベル・モデルレベルの findings(`authz:*`、`validation:*`、`agent-annotation:*`、`mass-assignment:*`、`hidden-columns:*`)には、コメントを付けられる特定の行が存在しません。これらはルートレジストラを実行し、モデルを検査することで生成されるためです。代わりに `config/audit.ts` で finding の `key`(`--json` の出力からそのままコピーできます)と必須の `reason` を指定して無視します:

```ts
// config/audit.ts
export default {
  ignore: [
    { key: 'authz:POST /webhooks/stripe', reason: 'コントローラでHMAC署名を検証済み' },
  ],
}
```

無視された finding はレポートから削除されず、`status: "ignored"` と `ignoreReason` を伴って残ります — 何も黙って握りつぶされません。`key` や `reason` が欠落しているエントリ、どの finding にもマッチしなかったエントリは、それ自体が警告として報告されるため、形骸化したルールに気づかないまま放置されることはありません。

`config/audit.ts` が受け付けるのは、ソース行を持たない finding(上記のルート/モデルレベルのもの)のみです。行に紐づく finding(ハードコードされた認証情報、生SQL、無効化されたセキュリティ既定値)には既に `// guren-audit-ignore` という手段があるため、それらを対象にしたエントリは適用されず、インラインコメントを使うよう促す警告になります — 目立たない第二の抑制手段になってしまうことを避けるためです。

### アーキテクチャ境界

プロジェクトルートに `guren.arch.ts` を置くだけで、フラグなしに `guren check` が境界を検証するようになります:

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

各ルールの `from` と `disallow` には、上で定義したレイヤー名か、インラインの glob を指定できます。既存コードベースに新しい境界を導入する際は `severity: 'warn'` から始め、違反がゼロになったら外す(デフォルトの `'fail'` に戻す)運用が安全です。

ルールが解析するのは実行時の依存です。型限定のimport(`import type { X } from '...'`・`export type { X } from '...'`・型位置の `import('...').X`)はコンパイルで消えるため、デフォルトでは対象外です。DTOやpropsのinterfaceをレイヤーをまたいで共有するのは通常問題ないからです。型レベルでも守りたい境界には、ルール(またはセット全体)に `includeTypeImports: true` を指定してください(ルール側の指定が優先されます):

```typescript
rules: [
  // クエリ層への型依存は、実行時依存まであと一歩のリファクタリング距離にある。
  { from: 'frontend', disallow: ['queries'], includeTypeImports: true },
]
```

`includeTypeImports` が及ぶのは `guren.arch.ts` に宣言したルールだけです。`modules/` ディレクトリで自動有効化されるゼロコンフィグのモジュール境界ルールはオプションを持たず、常に実行時importのみを解析します。

AIコーディングエージェントや大規模アプリで実用的に使うための2つのフラグ:

```bash
bunx guren check --arch      # アーキテクチャチェックのみ実行 — 編集フック向けの高速パス
bunx guren check --changed   # main とのマージベースからの変更ファイルのみを検査対象にする
```

プロジェクト内のファイルに解決できないimportは、失敗ではなく警告として報告されます — 解決できないパスがビルドをブロックすることはありません。

## アプリケーションモジュール

ルート数が数十を超えて増えてくると、`guren make:module` を使うことで、フラットな `app/`・`routes/`・`db/schema.ts` に全部を詰め込む代わりに、アプリの自己完結した一部分を切り出せます:

```bash
bunx guren make:module Billing
```

これにより `modules/billing/{index.ts, routes.ts, db/schema.ts}` が生成され、自動的に配線されます: `db/schema.ts` には `export * from '../modules/billing/db/schema'` が追加され、`src/app.ts` には `billingModule` の import と `createApp({ modules: [...] })` への登録が追加されます。

ほとんどの `make:*` コマンドは `--module <name>` を受け付け、プロジェクトルートの代わりにモジュール内にスキャフォールドできます:

```bash
bunx guren make:controller Invoice --module billing   # modules/billing/app/Http/Controllers/InvoiceController.ts
bunx guren make:model Invoice --module billing        # modules/billing/app/Models/Invoice.ts
```

`guren check`・`guren audit`・`guren context`・`model:list`・`doctor` はすべて `modules/*/` を自動的にスキャンします — 追加設定は不要です。例外は2つ: `make:auth`(認証はモジュール単位ではなくアプリ全体の関心事)と `make:migration`(drizzle-kit 駆動で、`drizzle.config.ts` が指すスキーマパスからマイグレーションを生成するため、モジュールの有無を問いません)。

モジュールの公開APIは、`defineModule()` の記述をexportする `index.ts` と、モジュール間で共有されるテーブル定義用の `db/schema.ts` です。`modules/` ディレクトリが存在すれば、`guren.arch.ts` なしでも `guren check` がこれを自動的に強制します: あるモジュールが別モジュールの内部(`index.ts` と `db/schema.ts` 以外)に踏み込んでimportすると失敗になり、トップレベルのアプリコードが同じことをしても同様に失敗します。

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

Inertiaのページは `modules/<name>/` 配下にコロケーションされません — トップレベルの `resources/js/pages/` にそのまま置かれ、代わりにモジュール名で名前空間分けされます(`resources/js/pages/billing/Invoices/Index.tsx`)。`make:feature Invoice --module billing` はこの規約に自動的に従います。

## AIエージェントハーネス

`create-guren-app` で作成したアプリには、AIエージェント向けのハーネスが最初から組み込まれます。scaffold 時に使用するエージェント(Claude Code・Codex・Cursor・GitHub Copilot・OpenCode)を選択すると、それぞれがネイティブに読み込むファイル構成でインストールされます(非対話環境では `--agents codex,cursor` のように指定、`--agents none` でスキップ)。

選択ごとに生成されるもの:

- **Claude Code**: プロジェクトガイドの `CLAUDE.md`、`.claude/` 配下の検証済みAPIルール・スキル・サブエージェント、開発サーバーの MCP エンドポイントを指す `.mcp.json`（エンドポイント自体は scaffold された `dev` スクリプトの `GUREN_MCP=1` で有効になります）、そしてフィードバックループを構成する hooks です。セッション開始時に `guren context` のプロジェクトマップが読み込まれ、ルート・コントローラ・モデル・スキーマ・ページの編集後には `guren check` が自動で再実行され、失敗があればその場でコーディングエージェントに報告されます。
- **Codex・Cursor・GitHub Copilot・OpenCode**: プロジェクトガイドの `AGENTS.md` と、`.agents/rules/`・`.agents/skills/` 配下の同じルール・スキル(スキルはエージェント横断の SKILL.md 標準形式)。加えて、Cursor にはネイティブ形式のルール(`.cursor/rules/guren-*.mdc`)、Copilot にはパススコープ付き instructions(`.github/instructions/guren-*.instructions.md`)、Codex にはハーネス自身のコマンドを承認不要にする許可リスト(`.codex/rules/guren.rules`)が生成されます。MCP クライアント設定は各ツールが参照する場所(`.codex/config.toml`・`.cursor/mcp.json`・`.vscode/mcp.json`・`opencode.json` の `mcp` エントリ)に書き出されます。これらのエージェントはハーネスの hooks を実行しないため、セッション開始時の `guren context` 実行と編集後の `guren check` 実行を `AGENTS.md` が指示します。

### アプリを作る前に: カタログから Guren のスキルを入れる

上のハーネスはアプリの `@guren/cli` の中にあるので、アプリができて初めて存在します。その手前、Guren を見たことのないエージェントが空のディレクトリにいる段階のために、Guren は導入用のスキル2本を [`gurenjs/agent-skills`](https://github.com/gurenjs/agent-skills) からエージェントカタログに公開しています。

```bash
# Claude Code
claude plugin marketplace add gurenjs/agent-skills
claude plugin install guren@gurenjs --scope user

# Cursor・Codex・Copilot・OpenCode・Gemini CLI など(Agent Skills CLI)
npx skills add gurenjs/agent-skills
```

インストールは user scope です。これらのスキルはプロジェクトが存在する*前*の段階のためのもので、何を作る場合でも同じ2本だからです。project scope にすると、たまたま居たリポジトリの設定に書き込まれ、すでにハーネスが入っているアプリの共同作業者にまで on-ramp を配ることになります。このプラグインは [Agent Plugins v1](https://agent-plugins.org) にも準拠しているので、ルートの `plugin.json` を読むクライアントならそのリポジトリから直接インストールできます。中身は `guren-new-app`(Guren を説明し、`bunx create-guren-app` で雛形を作り、引き渡す)と `guren-harness`(`bunx guren agent:init --target <agents>` を実行し、`guren context` → 編集 → `guren check` → `guren audit` のループを説明する)の2本です。ハーネスの rules や skills は意図的にコピーしていません。それらはアプリ自身の CLI が入れるもので、アプリの版数と揃い続けます。リポジトリは各リリース時に `packages/cli/templates/agent-catalog/` から生成されるので、変更はそちらへ送ってください(`gurenjs/agent-skills` へは送らないでください)。

| コマンド | 説明 | 例 |
|---------|------|-----|
| `agent:init` | 選択したエージェント向けのハーネスを既存アプリに導入(既存ファイルはスキップ、`--force` で上書き) | `bunx guren agent:init --target codex,cursor` |
| `agent:sync` | フレームワーク管理ファイル(rules・skills・サブエージェント・hooks)を、ディスク上で検出した全エージェント分まとめて最新版に更新 | `bunx guren agent:sync` |

`agent:init --target` には `claude`(既定)・`codex`・`cursor`・`copilot`・`opencode`・`all` を指定できます。`agent:sync` はユーザー所有のファイル(`CLAUDE.md`・`AGENTS.md`・`.claude/settings.json`・各 MCP クライアント設定)を上書きしないため、カスタマイズはフレームワークの更新後も維持されます(削除したユーザー所有ファイルは再作成されます)。MCP 設定が既に存在する場合、`agent:init` はファイルを上書きせず、手動で追記するためのスニペットを表示します。

フレームワーク管理ファイル(rules・skills・サブエージェント・hooks)は `agent:sync` が上書きします。それがこのコマンドの役割なので、プロジェクト固有のルールは配布ファイルに追記せず、自分のファイルとして別名で置いてください。上書きは必ず可視化されます。最新版と一致しているファイルはスキップされ、内容が異なっていたファイルは「置き換えた」として明示されます。`agent:sync --dry-run` を先に実行すると、何が書き込まれ・置き換えられ・削除候補になるかを、ファイルを一切変更せずに確認できます。`agent:init` も `--dry-run` を受け付けます(`--force` のプレビューとして使えます)。

リリースでフレームワークのルールやスキルが改名・削除されると、旧ファイルは配布先の全ルートに残り続けます。特に Cursor・Copilot は古い `.cursor/rules/guren-*.mdc` / `.github/instructions/guren-*.instructions.md` を glob で読み込み続けます。`agent:sync` はフレームワーク管理の場所で現行ハーネスに含まれないファイルを一覧表示し、`agent:sync --prune` を付けるとそれらを削除します。対象は常に**名前**で判定します。rules のルート(`.claude/rules/`、`.agents/rules/`)はハーネスが配布している(または過去に配布した)ルールのファイル名だけ、ネイティブルールは `guren-` プレフィックスだけ、skills のルート(`.claude/skills/`、`.agents/skills/`)はハーネスが配布している(または過去に配布した)スキルディレクトリだけです。配布ルールの隣(サブディレクトリを含む)に置いた自作のルールファイルや、自分で追加したスキル(`npx skills add` や Agent Plugins クライアントが同じディレクトリに入れたものを含む)は、一覧にも出ず削除もされません。例外はハーネス自身が配布している名前と衝突した場合だけです。スキルなら `dev-workflow`・`db-manage`・`scaffold`・`feature`・`guren-api`・`plugin-authoring`・`agent-interface`、ルールならエントリードキュメントに載っているファイル名(大文字小文字は区別しません)、そして Cursor・Copilot では名前の一覧ではなくプレフィックス判定なので `guren-` で始まるファイル**すべて**です。Cursor/Copilot の自作ルールは別のプレフィックスにしておき、`--prune` の前には一覧を確認してください。

## デプロイレシピ生成

CLI からデプロイ設定ファイルを直接生成できます。

```bash
# Dockerfile のみ
bunx guren deploy

# Fly.io（Dockerfile + fly.toml）
bunx guren deploy --target fly --app my-app

# Railway（Dockerfile + railway.json）
bunx guren deploy --target railway

# Vercel（vercel.json）
bunx guren deploy --target vercel

# すべてのレシピを一括生成（カスタムポート）
bunx guren deploy --target all --app my-app --port 4000
```

`--target` は `docker` / `fly` / `railway` / `vercel` / `all` をサポートします。

Vercel と Bun
Vercel は Bun を用いたデプロイをサポートしています。Bun プロジェクトでは主に次の二択が現実的です。

- `vercel.json` に Bun 用の install/build コマンドを記載してデプロイする（シンプルなアプリ向け推奨）。

  ```json
  {
    "installCommand": "bun install",
    "buildCommand": "NODE_ENV=production bun run build",
    "devCommand": "bun run dev"
  }
  ```

- Docker イメージを使ってデプロイし、実行環境や Bun のバージョンを固定する（ネイティブ依存や長時間実行がある場合に推奨）。

推奨: Bun の特定バージョンに依存する、あるいは長時間実行プロセスが必要な場合は Docker デプロイを選ぶと再現性が高くなります。生成される `vercel.json` は出発点です。プロジェクト構成に合わせてコマンドやルーティングを調整してください。

## OpenAPI コマンド

| コマンド | 説明 | 例 |
|---------|------|-----|
| `openapi:generate` | ルート定義から OpenAPI 3.1 ドキュメントを生成 | `bunx guren openapi:generate` |

オプションの `@guren/openapi` パッケージが必要です（`bun add @guren/openapi`）。

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

コマンドはルートコントラクトから Zod スキーマと OpenAPI メタデータ（`summary`、`description`、`tags`、`operationId`、`deprecated`）を抽出し、OpenAPI 3.1 JSON ドキュメントを生成します。ルートへのアノテーション方法は[ルーティング — OpenAPI](./routing.md#openapi-ドキュメント生成)を参照してください。

## ルートコマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `route:list` | 登録済み全ルートを一覧表示 | `bunx guren route:list` |

### route:list オプション

フィルタリングとソート機能付きで全アプリケーションルートを表示します。

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

`.agent()` メタデータを宣言したルートは、MCP ツールとして AI エージェントに公開されます（[ルーティング](./routing.md)を参照）。これらのコマンドは、エージェントから見えるものをルートグラフから直接導出して表示します。`.guren/agents.gen.ts` を読むわけではないため、そのマニフェストが存在しない場合や古い場合でも正しく答えます。

| コマンド | 説明 | 例 |
|----------|------|----|
| `tool:list` | このアプリが公開しているエージェントツールを一覧表示 | `bunx guren tool:list` |
| `tool:inspect` | 1 つのツールの導出結果を表示 | `bunx guren tool:inspect posts.store` |
| `tool:call` | エージェントと同じ経路で 1 つのツールを呼び出す | `bunx guren tool:call posts.index` |

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
```

| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `--routes` | `routes/web.ts` | ルートエントリファイルのパス |
| `--app` | カレントディレクトリ | アプリケーションルートディレクトリ |
| `--json` | `false` | 導出結果を JSON で出力 |

`tool:call` はさらに一歩進んで、MCP クライアントからの呼び出しと同じディスパッチ契約でツールを実際に呼び出します。アプリケーションを起動するので、ツールの一覧は稼働中のアプリが提供するグラフから取ります。`--routes` を受け付けないのはそのためです。

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
| `--as` | (未認証) | 指定ユーザーとして呼び出す(`user:42`)。開発専用: プロセスに `GUREN_TESTING=1` を設定し、実際の資格情報の代わりに注入されたユーザーをアプリが受け入れるようにします |
| `--preflight` | `false` | 実行ではなく verdict を要求する。ハンドラーは実行されません |
| `--app` | カレントディレクトリ | アプリケーションルートディレクトリ |
| `--json` | `false` | 呼び出し結果を JSON で出力 |

呼び出しがエラー結果として返った場合、コマンドは 0 以外で終了します。スクリプトが 422 や 403 を成功と読み違えないためです。[エージェントインターフェース: 自分でツールを呼ぶ](./agent-interface.md#自分でツールを呼ぶ)も参照してください。

表示される内容はすべて、ルートがすでに持っている契約から導出されます。入力スキーマは `params`・`query`・`body` をマージしたもの、出力スキーマは `output`、認可アビリティはミドルウェアチェーンが実際にチェックしているポリシーのものです。二重に宣言する箇所がないため、エンドポイントが検証しないスキーマをツールが広告することはありません。

`bunx guren codegen` は同じ導出結果を `.guren/agents.gen.ts` に書き出します。ツールを 1 つも公開していないアプリでは、このファイルは生成されず、既存のものは削除されます。

## 設定コマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `config:cache` | 全設定ファイルをキャッシュ | `bunx guren config:cache` |
| `config:clear` | 設定キャッシュをクリア | `bunx guren config:clear` |
| `config:show` | 設定キャッシュ情報を表示 | `bunx guren config:show` |

### 設定キャッシュ

本番環境でのパフォーマンス向上のために設定ファイルをキャッシュします。

```bash
# 全設定をキャッシュ
bunx guren config:cache

# キャッシュをクリア
bunx guren config:clear

# キャッシュ情報を表示
bunx guren config:show
```

キャッシュは `bootstrap/cache/config.json` に保存されます。設定ファイルは `config/` ディレクトリ（サブディレクトリ含む）から読み込まれます。

**Note:** 設定ファイルを変更した後は、`config:cache` を再実行してキャッシュを更新してください。

## データベースコマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `db:migrate` | 保留中のマイグレーションを実行 | `bunx guren db:migrate` |
| `db:rollback` | 最後のマイグレーションバッチをロールバック | `bunx guren db:rollback` |
| `db:reset` | 全テーブルを削除してマイグレーションを再実行 | `bunx guren db:reset` |
| `db:seed` | データベースシーダーを実行 | `bunx guren db:seed` |

### db:migrate オプション

```bash
# マイグレーションを実行
bunx guren db:migrate

# 本番環境でマイグレーションを強制実行
bunx guren db:migrate --force

# マイグレーションパスを指定
bunx guren db:migrate --path db/migrations
```

### db:rollback オプション

```bash
# 最後のバッチをロールバック
bunx guren db:rollback

# 指定ステップ数ロールバック
bunx guren db:rollback --step 3

# 全マイグレーションをロールバック
bunx guren db:rollback --all
```

### db:seed オプション

`db:seed` は、`config/database.ts` の `seedersFolder`（スキャフォールドしたアプリでは `db/seeders`）にあるシーダーをファイル名順にすべて実行します。個別のシーダーだけを実行するオプションはありません。実行順を決めたい場合は、ファイル名に `001_`、`002_` のような接頭辞を付けてください。

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
> `--json` が JSON にするのはコマンド自身のサマリだけです。シーダーの標準出力は抑制されません（`make:seeder` が生成する雛形は 1 行ログを出します）。`jq` に流す場合はシーダー側のログを止めてください。

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

以下のオプションはすべての `make:*` / `add` コマンドで共通の挙動をします。

- `--force` / `-f`: 既存ファイルを上書き
- `--dry-run`: 生成内容を表示するだけで書き込まない（予定）
- `--cwd <path>`: 指定パスのワークスペースでコマンドを実行（既定はカレントディレクトリ）

## テンプレートの特徴

生成物はフレームワークの Laravel 風の設計方針に沿っています。

- コントローラーは `Controller` を継承し、`this.inertia()` などのヘルパーを使用。
- モデルは `Model<TRecord>` を継承し、`static table` を事前に設定。手早い CRUD にはヘルパーを、複雑なクエリは Drizzle RQB へ直接。`Model.query(db)` でモデル起点の RQB も書けます。
- ビューは React + TypeScript + Tailwind CSS の関数コンポーネント。

生成後はルート配線と Drizzle スキーマへの `static table` 接続を忘れずに。高度なクエリが必要ならモデルを介さず Drizzle の DB（`getDatabase()`）や `Model.query()` を使うと型安全のまま柔軟に書けます。

## 新規アプリのスキャフォールド

ゼロから始めるときは専用ブートストラッパーを使います。

```bash
bunx create-guren-app my-app --mode ssr
```

CLI はデフォルトテンプレートをコピーし、メタデータを更新します。`--mode ssr`（既定）で SSR が有効に、`--mode spa` で無効になります。空でないディレクトリに生成する場合は `--force` を付けます。

## トラブルシューティング
- `command not found: bunx`: Bun が古い可能性があります。1.1 以降にアップグレードしてください。
- `Error: Port already in use`: 開発サーバー（既定 3333）が埋まっています。`.env` の `PORT` を変更して再起動してください。
- `Database connection failed`: デフォルトは SQLite（`./data/guren.db`）です。PostgreSQL を使う場合は `.env` の `DATABASE_URL` を確認してください。

## 対話 REPL

フレームワーク対応のコンソールを起動します。

```bash
bunx guren console
```

> これは対話型 REPL であり、アプリケーションが定義するコマンドではありません。後者を実行するには `bun run console <command>` を使います（[コンソールコマンドガイド](./console.md)参照）。

アプリケーションをブート（`src/main.ts` と登録済みプロバイダーを尊重）し、`app`、`auth`、発見済みモデル、DB ヘルパー、`@guren/testing` のユーティリティなどを事前ロードしたプロンプトに入ります。`:help` でショートカット、`:editor` で複数行入力を使えます。

### 典型的な流れ

1. **起動** — プロジェクトルートで `bunx guren console`。
2. **コード実行** — `src/main.ts` などのブートストラップ済みスコープを共有するため、`await Post.all()` のようなステートメントをそのまま実行できます。
3. **状態リセット** — `Ctrl+D`（または `.exit`）で終了し、必要に応じて再起動。

### Tips

- `Ctrl+D` または `.exit` で REPL を抜ける。
- `reloadModels()` で、コンソール起動中に追加したモデルを再検出。
- `:load path/to/script.ts` でファイル内容を現在のセッションに読み込む。
- 素の Bun REPL が必要なら `bun repl`（または `bun repl --inspect`）を使う。

これらのパターンで、専用の `guren repl` を待たずとも反復開発の体験を得られます。

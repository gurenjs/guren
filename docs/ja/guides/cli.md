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

## 主要コマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `key:generate` | 新しい `APP_KEY` 値を生成。`--write` で `.env` に保存 | `bunx guren key:generate --write` |
| `deploy` | Docker/Fly.io/Railway/Vercel 向けデプロイ設定ファイルを生成 | `bunx guren deploy --target all --app my-app --port 3333` |
| `make:controller <Name>` | `app/Http/Controllers` にコントローラーを生成 | `bunx guren make:controller PostController` |
| `make:model <Name>` | 最小のモデルクラスと型定義を `app/Models` に生成（`db/schema` から `camelCase(Name)s` を import） | `bunx guren make:model Post` |
| `make:view <path>` | `resources/js/pages` に React コンポーネントを生成 | `bunx guren make:view posts/Index` |
| `make:auth` | ログイン/ログアウトと新規登録のコントローラー、プロバイダー、ビュー、マイグレーション、シーダー、ルートをスキャフォールド（`--minimal` で登録機能を省略） | `bunx guren make:auth` |
| `make:middleware <Name>` | `app/Http/Middleware` にミドルウェアを生成 | `bunx guren make:middleware Auth` |
| `make:seeder <Name>` | データベースシーダーファイルを生成 | `bunx guren make:seeder UserSeeder` |
| `make:job <Name>` | キュー可能なジョブクラスを生成 | `bunx guren make:job SendEmail` |
| `make:event <Name>` | イベントクラスを生成 | `bunx guren make:event UserRegistered` |
| `make:listener <Name>` | イベントリスナークラスを生成 | `bunx guren make:listener SendWelcomeEmail` |
| `make:notification <Name>` | 通知クラスを生成 | `bunx guren make:notification InvoicePaid` |
| `make:mail <Name>` | メールクラスを生成 | `bunx guren make:mail WelcomeEmail` |
| `make:policy <Name>` | 所有者ベースのデフォルトを備えた認可ポリシーを `app/Policies` に生成 | `bunx guren make:policy Post` |

> **Note:** `make:*` は既存ファイルを上書きしません。必要なら `--force` を付けてください。

## 検査・監査コマンド

リリース前のアプリ検証に使えるコマンドです。AIコーディングエージェント向けにも設計されています(`--json` で機械可読な出力になります)。

| コマンド | 説明 | 例 |
|---------|------|-----|
| `check` | ルート・コントローラ・ページ・モデル間の整合性を検証。`guren.arch.ts` があればアーキテクチャ境界も検証 | `bunx guren check --json` |
| `audit` | セキュリティ監査: 変更系ルートのバリデーション/認証の欠如、文字列補間付き生SQL、ハードコードされた認証情報、無効化されたセキュリティ既定値、mass assignment 設定、`static hidden` 未登録の機微カラムを検査 | `bunx guren audit --json` |
| `doctor` | プロジェクトの健全性レポート(環境変数・設定・生成ファイル)と次のアクション | `bunx guren doctor --next` |

`check` と `audit` はいずれも失敗(fail)を検出すると非ゼロの終了コードを返すため、CI に組み込めます。

```bash
bunx guren check
bunx guren audit
```

名前付きミドルウェアで保護されたルート(例: `router.middleware('auth').group(...)`)は保護済みと認識されます。`/login` や `/register` などのゲストフローは認証チェックの対象外です。

誤検出は、対象行またはその直前の行に `// guren-audit-ignore` を置くことで抑制できます:

```ts
// guren-audit-ignore -- ドキュメント用のサンプル値
const apiKey = 'example-not-a-real-key'
```

ルートレベル・モデルレベルの findings(`authz:*`、`validation:*`、`mass-assignment:*`、`hidden-columns:*`)には、コメントを付けられる特定の行が存在しません。これらはルートレジストラを実行し、モデルを検査することで生成されるためです。代わりに `config/audit.ts` で finding の `key`(`--json` の出力からそのままコピーできます)と必須の `reason` を指定して無視します:

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

`create-guren-app` で作成したアプリには、AIエージェント向けのハーネスが最初から組み込まれます。内容は、プロジェクトガイドの `CLAUDE.md`、`.claude/` 配下の検証済みAPIルール・スキル・サブエージェント、開発サーバーの MCP エンドポイントを指す `.mcp.json`、そしてフィードバックループを構成する hooks です。セッション開始時に `guren context` のプロジェクトマップが読み込まれ、ルート・コントローラ・モデル・スキーマ・ページの編集後には `guren check` が自動で再実行され、失敗があればその場でコーディングエージェントに報告されます。

| コマンド | 説明 | 例 |
|---------|------|-----|
| `agent:init` | 既存アプリにエージェントハーネスを導入(既存ファイルはスキップ、`--force` で上書き) | `bunx guren agent:init` |
| `agent:sync` | フレームワーク管理ファイル(`.claude/` の rules・skills・agents・hooks)を最新版に更新 | `bunx guren agent:sync` |

`agent:sync` はユーザー所有のファイル(`CLAUDE.md`・`.mcp.json`・`.claude/settings.json`)には触れないため、カスタマイズはフレームワークの更新後も維持されます。

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

```bash
# 全シーダーを実行
bunx guren db:seed

# 特定のシーダーを実行
bunx guren db:seed --class UserSeeder

# 本番環境でシーディングを強制実行
bunx guren db:seed --force
```

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

オプションは `packages/core/src/cli` で一元化され、挙動が統一されています。

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

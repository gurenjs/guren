# サーバーレスデプロイ（AWS Lambda）

Guren は AWS Lambda の Node.js ランタイム上で動作します。公式プラグイン `@guren/plugin-lambda` がバンドルを担当し、CDK コンストラクトが HTTP・キュー・スケジュールタスク・CLI コマンド・静的アセットまでフルスタックをプロビジョニングします。

## セットアップ

```bash
bunx guren plugin @guren/plugin-lambda
bun add @guren/plugin-lambda
```

インストールすると `src/app.ts` に `lambdaPlugin()` が登録され、`src/lambda.ts` がスキャフォールドされます。このモジュールの export がそのまま Lambda ハンドラーになります:

```typescript
// src/lambda.ts（スキャフォールド）
import app from './app.js'
import { createLambdaHandler, createSqsHandler } from '@guren/core/lambda'

// コールドスタート時に一度だけ起動し、全ハンドラーで共有されます。
await app.boot()

// API Gateway / ALB / Lambda Function URL 経由の HTTP リクエスト。
export const http = createLambdaHandler(app)

// SQS キューのジョブ処理（SQS イベントソースをこのハンドラーに接続）。
export const queue = createSqsHandler()
```

アプリにスケジューラーやコンソールカーネルを定義したら、スキャフォールド内のコメントアウトされた `schedule` / `console` export を有効化してください。

## ビルド

```bash
bunx guren lambda:build
```

このコマンドはまず `guren doctor` と同じデプロイランタイムチェックを走らせ(インメモリのセッション/OAuth ストア、`ScryptHasher`、ファイルシステムからのプロバイダ探索に当たると警告します。ビルドは止めません。どれもローカルでは動き、Lambda では壊れるものです)、次にアプリの `build` スクリプトを実行し、`.lambda/` ディレクトリを組み立てます:

| パス | 内容 |
|------|------|
| `function/` | 自己完結の ESM バンドル（`handler.js`）+ SSR バンドル + Drizzle マイグレーション — これを関数コードとしてデプロイ |
| `assets/` | S3 用にステージングされた `public/`。ビルド済みアセットは `/assets/` と `/public/assets/` の両方にミラー |
| `env.json` | 関数が必要とする環境変数 — 同じ値がバンドルにもデフォルトとして焼き込まれます |

ハンドラー識別子はバンドルに対応します: `handler.http`、`handler.queue`、`handler.schedule`、`handler.console`。

`process.env.NODE_ENV` はバンドル時に `"production"` に固定されます — バンドラーがこの値をインライン化するため、実行時の設定だけでは開発モードのバンドルを直せません。Inertia のアセット位置（`GUREN_INERTIA_ENTRY`、`GUREN_INERTIA_STYLES`、SSR エントリ）もデフォルトとして焼き込まれますが、関数の実際の環境変数が常に優先されます。

`--zip` を渡すと直接アップロード用の `function.zip` も生成されます。CDK はディレクトリを自動でアーカイブするため不要です。

## ハンドラー

### HTTP — `createLambdaHandler(app)`

アプリの fetch ハンドラーを API Gateway v1/v2 と ALB 向けにラップします。ルート・コントローラー・ミドルウェアはサーバー構成と同一に動作します。

### キュー — `createSqsHandler()`

SQS メッセージを Guren のジョブとして処理します。**部分バッチ失敗**に対応 — 失敗したメッセージだけが SQS に戻されリトライされます。

キュープロバイダで SQS ドライバを設定します:

```typescript
import { SQSClient } from '@aws-sdk/client-sqs'
import { createSqsAdapter, SqsDriver, setQueueDriver } from '@guren/core'

const adapter = createSqsAdapter(new SQSClient({ region: 'ap-northeast-1' }))
setQueueDriver(new SqsDriver(adapter, {
  queueUrl: process.env.SQS_QUEUE_URL!,
  // オプション: 論理キュー名を別の SQS URL にマッピング
  queueUrls: {
    emails: process.env.SQS_EMAILS_QUEUE_URL!,
  },
}))
```

ジョブのディスパッチはサーバー上と同じです — `await SendEmailJob.dispatch({ to: 'user@example.com' })`。`SqsDriver` がジョブを SQS にシリアライズし、Lambda ハンドラーがデシリアライズして実行します。

### スケジュール — `createScheduleHandler(scheduler)`

EventBridge から呼び出されたときに実行予定のタスクを処理します。`rate(1 minute)` の EventBridge ルールでこのハンドラーをトリガーしてください。既存の `Scheduler` とタスク定義は変更なしで動作します。

### コンソール — `createConsoleHandler(kernel)`

アプリの `ConsoleKernel` に登録したコマンド — `src/console.ts` が `kernel` としてエクスポートするもの — を実行します。コマンドの定義と登録については [コンソールコマンドガイド](./console.md) を参照してください。

スキャフォールドされた `src/lambda.ts` の `console` export のコメントを外すとハンドラが有効になります。

カーネルに組み込みコマンドはありません。マイグレーション用のコマンドが必要になるのは Data API アダプタだけです（`getDatabase()` が意図的に未適用のマイグレーションを実行しないため。他のアダプタは初回利用時に適用します）。このトレードオフと `migrateOnStart` については [Aurora Serverless の項](./database.md#aurora-serverlessaws-data-apiサポート) を参照してください。いずれにせよ、帯域外で実行すればリクエストパスからレイテンシを外せます。

```bash
bunx guren make:command Migrate --command db:migrate
```

```typescript
// app/Console/Commands/MigrateCommand.ts
import { Command } from '@guren/core'
import { migrateDatabase } from '../../../config/database.js'

export default class MigrateCommand extends Command {
  static signature = 'db:migrate'
  static description = 'Apply pending database migrations'

  async handle(): Promise<void> {
    await migrateDatabase()
  }
}
```

`make:command` が `src/console.ts` への登録行を出力します。そのうえで AWS CLI から呼び出します:

```bash
aws lambda invoke --function-name my-app-console \
  --cli-binary-format raw-in-base64-out \
  --payload '{"command": "db:migrate"}' response.json
```

成功時は `{ exitCode: 0 }`、失敗時は `{ exitCode: 1 }` を返します。

## サーバーサイドレンダリング

SSR は追加設定なしで Lambda 上で動作します。`lambda:build` が Vite の SSR バンドルを関数ディレクトリにコピーし、その場所をバンドルに焼き込みます。サーバーは最初の Inertia レンダリング時にレンダラーをロードします。SSR ビルドがないアプリは CSR のみの関数になります — どちらの場合もフラグは不要です。

## データベース

### Aurora Serverless v2 + RDS Data API（推奨）

Data API は HTTP ベースです: コネクションプールも RDS Proxy も不要で、関数を VPC 内に配置する必要もありません。`createAwsDataApiDatabase` を使います:

```typescript
// config/database.ts
import { createAwsDataApiDatabase } from '@guren/core'

const database = createAwsDataApiDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  // DATABASE_NAME / DATABASE_RESOURCE_ARN / DATABASE_SECRET_ARN にフォールバック
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
```

ドライバも合わせてインストールしてください（`bun add @aws-sdk/client-rds-data`）。関数にはクラスターへの `rds-data` アクションとシークレットへの `secretsmanager:GetSecretValue` が必要です — 後述の CDK コンストラクトの `dataApi` オプションが両方を配線します。認証は関数の IAM ロールを使用します。`drizzle-kit generate`/`push` には `drizzle.config.ts` で `driver: 'aws-data-api'` を設定します。

ファクトリの詳細は[データベースガイド](./database.md)を参照してください。

### 従来の RDS + RDS Proxy

関数を VPC 内で動かす場合は `createPostgresDatabase` が RDS に対して動作します。接続は RDS Proxy 経由にし、プリペアドステートメントは無効化してください — プロキシのセッションピニングを引き起こします:

```typescript
const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  connectionString: () => process.env.DATABASE_URL,
  clientOptions: { prepare: false, max: 1 },
})
```

### 使うクライアントだけがバンドルされる

ORM は各ダイアレクトのクライアントを動的 import で読み込みますが、バンドラーは
その分岐が実行されうるかに関係なく import をたどります。そのため何もしなければ、
Postgres アプリが、選んでもいない `mysql2` の解決に失敗してビルドできません。
ビルドは `config/database.ts` がどのファクトリを呼んでいるかを読み取り、それ以外の
ダイアレクトのクライアントを、到達したら例外を投げるスタブに差し替えます。

読み取るのは `config/database.ts`（または `db/config.ts`）だけなので、別の場所で
2 つ目の接続を開いているアプリは、使うデータベースを明示してください。再 export や
別モジュール経由など、ファクトリ名が config に現れない書き方をしている場合も同様
です（ビルドは「判別できなかった」と報告して何もスタブ化しません）:

```bash
bunx guren lambda:build --database postgres,sqlite
```

## ランタイム検出

ランタイムに応じてサービスを条件付きで設定できます:

```typescript
import { isLambda, getLambdaContext } from '@guren/core/lambda'

if (isLambda()) {
  const ctx = getLambdaContext()!
  // ctx.functionName — Lambda 関数名
  // ctx.region       — AWS リージョン
  // ctx.memorySize   — 割り当てメモリ（MB）
  // ctx.tmpDir       — 書き込み可能な一時ディレクトリ（/tmp）
  // ctx.logGroup     — CloudWatch ロググループ
}
```

## パスワードハッシュ

デフォルトのハッシャーはランタイムを検出します: ローカルでは Bun の scrypt、Lambda 上では Node の `crypto.scrypt`（`NodeHasher`）。新規アプリでは設定不要です。

> [!WARNING]
> 2 つの実装は互換性のないハッシュ形式を生成します。パスワードハッシュを保存済みの Bun ホストのアプリを Lambda に移行する場合は、パスワードの再ハッシュか複数形式対応の検証器が必要です。

## ロギング

Lambda は `stderr` を自動的に CloudWatch へ送ります。JSON 形式のコンソールロギングを使ってください:

```typescript
import { LogManager } from '@guren/core'

const log = new LogManager({
  default: 'console',
  channels: {
    console: { driver: 'console', level: 'info', format: 'json', colors: false },
  },
})
```

## 静的アセット

Lambda は静的ファイルの配信に向きません。`lambda:build` が `public/` を `.lambda/assets` にステージングし、CDK コンストラクト（後述）が S3 バケットと、`/assets/*`・`/public/*` をバケットへルーティングする CloudFront ディストリビューション（デフォルトオリジンはアプリ）をプロビジョニングします。

このディストリビューションは関数より先にファイルに応答するため、フレームワーク自身が `public/` を配信するときのガードはここでは動きません。コンストラクトはアセット向けビヘイビアに viewer-response の CloudFront Function を付けてこれを復元します: ブラウザがドキュメントとして描画する形式 (`.html`、`.htm`、`.svg`、`.xhtml`、`.xml`) には、階層の深さや拡張子の大文字小文字によらず `Content-Disposition: attachment` と `X-Content-Type-Options: nosniff` が付きます。画像、スクリプト、スタイルシート、フォントはそのままで、デフォルトビヘイビア (つまりアプリ) も自分のヘッダーのままです。

手動でアセットをデプロイする場合は、`.lambda/assets` をバケットに同期し、関数の `GUREN_INERTIA_ENTRY` / `GUREN_INERTIA_STYLES` に CDN の URL を設定してください（値は `.lambda/env.json` に一覧されています）。ただし上記のドキュメント向けルールはステージング済みディレクトリではなく CDK コンストラクトに付属するため、自前のディストリビューションでは `public/` の `.svg` がアプリのオリジン上でインラインに描画されます。

## 設定上の注意

### サービスプロバイダ

自動検出（`Bun.Glob`）は Lambda では使えません。プロバイダはすべて明示的に列挙してください:

```typescript
const app = createApp({
  providers: [
    DatabaseProvider,
    AuthProvider,
    CacheProvider,
    // ... すべてのプロバイダ
  ],
  routes: registerRoutes,
})
```

### マイグレーションとシード

スキャフォールドされた `config/app.ts` は、ローカル開発の利便性としてブート時にシードを実行し、`NODE_ENV=production` ではスキップします。このガードはそのまま残してください。Lambda はコールドスタートのたびにアプリをブートするため、ブート時シードは本番データに対して繰り返し実行されてしまいます。

**マイグレーションは関数に同梱されます。** `lambda:build` が `db/migrations/` をバンドルの隣にコピーするため、`db:migrate` コンソールコマンドでその場で適用できます。コマンド定義と呼び出し方は [コンソール — `createConsoleHandler(kernel)`](#コンソール--createconsolehandlerkernel) を参照してください。

**シーダーは関数内では実行できません。** シーダーはスキーマや `@guren/core` を import する通常の `.ts` モジュールですが、デプロイされる関数は `node_modules` も TypeScript ローダーも持たない自己完結バンドルであり、Node.js ランタイムはこれらを読み込めません。プロジェクトのソースがある環境からシードしてください:

```bash
DATABASE_URL='<本番の接続文字列>' bunx guren db:seed --force
```

手動適用ではなくリリースに同梱したいデータセットは、マイグレーションとして表現すれば関数と一緒に配布されます。

### ストレージとファイルシステム

Lambda のファイルシステムは `/tmp`（512 MB、一時的）を除いて読み取り専用です。`/tmp` は一時キャッシュのみに使い、永続ストレージには `S3Driver` 経由で S3 を使ってください。

### セッションとキャッシュ

インメモリストアは呼び出しごとに失われるため、セッションには Lambda の呼び出しをまたいで生存するバックエンドが必要です。

多くのアプリには `DatabaseSessionStore`（`@guren/core`）が推奨デフォルトです — アプリが既に接続しているデータベースにセッションを永続化するため、追加のインフラが不要です:

```typescript
import { DatabaseSessionStore } from '@guren/core'
import { sessions } from '@/db/schema'

app.use(createSessionMiddleware({ store: new DatabaseSessionStore(sessions) }))
```

期限切れの行は読み取り時に存在しないものとして扱われます。テーブルを小さく保つため、スケジュールタスク（`createScheduleHandler` 経由など）から `store.deleteExpired()` を呼んでください。

セッションの書き込み負荷をプライマリ DB から逃したい高トラフィックアプリでは、代わりに `RedisSessionStore`（ElastiCache）を使ってください。キャッシュには引き続き Redis や DynamoDB が有効です — 下のインフラ表を参照してください。

## インフラ推奨構成

| 項目 | 推奨 |
|------|------|
| **HTTP トリガー** | API Gateway v2（HTTP API）または ALB |
| **データベース** | Aurora Serverless v2 + Data API（`createAwsDataApiDatabase`）— または RDS + RDS Proxy |
| **セッション** | `DatabaseSessionStore`（追加インフラ不要）— セッション負荷が高い場合は `RedisSessionStore`（ElastiCache） |
| **キャッシュ** | `RedisCacheStore` 経由の Redis（`@guren/core/redis` にはセッション/レート制限/API トークンストアも同梱）、一時キャッシュなら `/tmp` + `FileStore` |
| **キュー** | SQS（`SqsDriver` + `createSqsHandler()`） |
| **スケジューリング** | EventBridge + `createScheduleHandler()` |
| **CLI コマンド** | 専用 Lambda + `createConsoleHandler()` |
| **静的アセット** | CloudFront + S3（CDK コンストラクトがプロビジョニング） |
| **ロギング** | CloudWatch（stderr、JSON 形式） |

## CDK でデプロイ

プラグインは全トポロジーを配線する CDK コンストラクトを同梱しています — HTTP API、デッドレターキューと部分バッチ失敗対応のキューワーカー、EventBridge ルール、コンソール関数、そしてアセット用の CloudFront + S3:

```bash
bun add aws-cdk-lib constructs
```

```typescript
import { App, Stack } from 'aws-cdk-lib'
import { GurenLambdaApp } from '@guren/plugin-lambda/cdk'

const app = new App()
const stack = new Stack(app, 'MyApp')

new GurenLambdaApp(stack, 'App', {
  functionDir: '../.lambda/function',
  assets: { dir: '../.lambda/assets' },
  queue: {},        // SQS + ワーカー（ジョブをディスパッチしないなら省略）
  schedule: {},     // EventBridge ルール、毎分（schedule export が必要）
  console: true,    // `aws lambda invoke` で db:migrate などを実行
  // 全関数に DATABASE_* 環境変数と rds-data / シークレット読み取りの
  // IAM 権限を配線します。
  dataApi: {
    database: 'appdb',
    resourceArn: process.env.DATABASE_RESOURCE_ARN!,
    secretArn: process.env.DATABASE_SECRET_ARN!,
  },
  environment: {
    APP_KEY: process.env.APP_KEY!,
  },
})
```

各サブリソースはプロパティ（`httpFunction`、`queue`、`distribution` など）として公開されており、カスタムドメインの接続・IAM 権限の追加・関数ごとのメモリ調整といったカスタマイズができます。そのままデプロイできる完全な CDK アプリは[デプロイレシピ](https://github.com/gurenjs/guren/tree/main/examples/deploy/serverless)にあります。

```bash
bunx guren lambda:build
bunx cdk deploy
```

> [!WARNING]
> `lambda:build` を自前のバンドラーに置き換える場合は、識別子マングリングを無効にしてください。Guren はキュー投入されたジョブ（既定でクラス名となる wire name）、永続化された通知の種別、HTTP 例外の名前といった永続レコードにクラス名を保存するため、マングルすると前回のデプロイが書き込んだレコードを解決できなくなります。`bun build` では `--minify` ではなく `--minify-whitespace --minify-syntax` を、`esbuild` では `minifyIdentifiers: false` を、`tsdown` / `rolldown` では `mangle: false` だけでは不十分です(compressが1箇所でしか使われないクラスを無名クラス式にインライン化し、`name` が `""` になります)。`minify: true` ではなく `minify: { compress: { keepNames: { class: true, function: true } }, mangle: false }` を指定します。Bun では `--keep-names` / `keepNames` は代替になりません。Bun 1.3.14 時点でフラグは受け付けられますが、クラス名はマングルされたままです。`lambda:build` はこの設定を済ませてあります。
>
> どうしてもマングルする場合は、すべてのジョブに `jobName` を、すべての通知に明示的な `type` を宣言し、永続レコード上の識別子をクラス名から切り離す必要があります（[ジョブ名を固定する](./queue.md#ジョブ名を固定する) を参照）。どちらも未宣言ならクラス名が既定値になり、例外名は常にクラス名から導出されます。識別子を保持するほうが安全な既定であることに変わりはありません。

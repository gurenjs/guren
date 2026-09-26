# サーバーレスデプロイ（AWS Lambda）

Guren は AWS Lambda の Node.js ランタイムで動きます。バンドルは公式プラグイン `@guren/plugin-lambda` が受け持ち、HTTP、キュー、スケジュールタスク、CLI コマンド、静的アセットまでの一式は CDK コンストラクトがプロビジョニングします。

## セットアップ

```bash
bunx guren plugin @guren/plugin-lambda
bun add @guren/plugin-lambda
```

インストールすると、`src/app.ts` に `lambdaPlugin()` が登録され、`src/lambda.ts` の雛形が生成されます。このモジュールの export がそのまま Lambda のハンドラーになります。

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

アプリにスケジューラーやコンソールカーネルを定義したら、雛形の中でコメントアウトされている `schedule` / `console` の export を有効にしてください。

## ビルド

```bash
bunx guren lambda:build
```

このコマンドは、最初に `guren doctor` と同じデプロイランタイムのチェックを実行します。インメモリのセッション/OAuth ストア、[Bun でしか読めないパスワードハッシャー](/docs/guides/authentication#パスワードハッシャー)、ファイルシステムからのプロバイダ探索が見つかると警告を出しますが、ビルドは止めません(どれもローカルでは動き、Lambda では動かなくなるものです)。続いてアプリの `build` スクリプトを実行し、`.lambda/` ディレクトリを組み立てます。

| パス | 内容 |
|------|------|
| `function/` | 自己完結した ESM バンドル（`handler.js`）、SSR バンドル、Drizzle のマイグレーション。これを関数のコードとしてデプロイします |
| `assets/` | S3 に置くためにステージングした `public/`。ビルド済みのアセットは `/assets/` と `/public/assets/` の両方に置かれます |
| `env.json` | 関数が必要とする環境変数。同じ値がデフォルトとしてバンドルにも埋め込まれます |

ハンドラーの識別子はバンドルに合わせて `handler.http`、`handler.queue`、`handler.schedule`、`handler.console` になります。

`process.env.NODE_ENV` はバンドル時に `"production"` に固定されます。バンドラーがこの値をコードに埋め込むので、開発モードでバンドルしてしまったものを実行時の設定だけで直すことはできません。Inertia のアセットの場所（`GUREN_INERTIA_ENTRY`、`GUREN_INERTIA_STYLES`、SSR のエントリ）もデフォルトとして埋め込まれますが、関数に実際に設定した環境変数のほうが常に優先されます。

`--zip` を渡すと、直接アップロードするための `function.zip` も作られます。CDK はディレクトリを自分でアーカイブするので、CDK を使う場合は不要です。

## ハンドラー

### HTTP — `createLambdaHandler(app)`

アプリの fetch ハンドラーを、API Gateway v1/v2 と ALB から呼べるようにラップします。ルート、コントローラー、ミドルウェアは、サーバーで動かす場合とまったく同じように動きます。

### キュー — `createSqsHandler()`

SQS のメッセージを Guren のジョブとして処理します。Lambda のイベントソースマッピングでは `ReportBatchItemFailures` を有効にしてください（同梱の CDK コンストラクトでは設定済みです）。標準キューのバッチは並行して実行し、失敗したレコードを個別に返します。ARN が `.fifo` で終わる FIFO キューは 1 件ずつ順番に実行し、失敗が出たらそのレコードと未処理のレコードをすべて返して、SQS が順序を保てるようにします。

試行回数は、ジョブ本文に記録済みの回数に AWS の `ApproximateReceiveCount` を足した値です。受信回数が正の値でないレコードは失敗として返します。`maxAttempts` に達した試行が失敗すると、キューワーカーと同じく、その試行のエラーを渡して `failed()` を 1 回だけ呼びます。それ以降に配信されたときは、`handle()` も `failed()` も実行しません。最終的に失敗したメッセージも `batchItemFailures` に残るので、キューのリドライブポリシーによってデッドレターキューへ移されます。このポリシーは自分で設定してください。`maxAttempts` はメッセージを削除せず、デッドレターキューも作りません。

`handle()` は、再配信によって何度呼ばれても問題が起きないように実装してください。上限は AWS が配信した回数で数えるので、FIFO で前のレコードが失敗して未処理のまま返されたレコードの受信回数も含まれます。そのため、一度も実行されないまま上限に達するレコードも出てきます。そうしたレコードは `failed()` を通らずにデッドレターキューへ移ります。キューの `maxReceiveCount` は、この挙動を踏まえて設定してください。リドライブの上限が低いと、`maxAttempts` に達して `failed()` が呼ばれる前にジョブが移されることがあります。実行して失敗したレコードは、ジョブ名、試行回数、エラーを JSON でログに出します。FIFO のバッチが途中で止まったときは、未処理のまま返したレコードもログに残ります。

SQS ドライバは、`guren add queue` が生成する `config/queue.ts` で設定し、`createApp({ config })` に加えます。

```typescript
// config/queue.ts
import { SQSClient } from '@aws-sdk/client-sqs'
import { createSqsAdapter, defineQueueConfig, SqsDriver } from '@guren/core'

export default defineQueueConfig((env) => ({
  default: 'sqs',
  drivers: {
    sqs: () =>
      new SqsDriver(createSqsAdapter(new SQSClient({ region: 'ap-northeast-1' })), {
        queueUrl: env.SQS_QUEUE_URL,
        // オプション: 論理キュー名を別の SQS URL にマッピング
        queueUrls: {
          emails: env.SQS_EMAILS_QUEUE_URL,
        },
      }),
  },
}))
```

`SQS_QUEUE_URL` と `SQS_EMAILS_QUEUE_URL` は `config/env.ts` で宣言してください（[設定](./configuration.md) を参照）。宣言しておけば、値を設定し忘れた関数は、最初にジョブをディスパッチしたときではなく起動の時点で失敗します。キューをサービスプロバイダで設定しているアプリも、そのまま動きます。詳しくは [サービスプロバイダを使うアプリ](./configuration.md#サービスプロバイダを使うアプリ) を参照してください。

ジョブのディスパッチはサーバーで動かす場合と同じで、`await SendEmailJob.dispatch({ to: 'user@example.com' })` のように書きます。`SqsDriver` がジョブをシリアライズして SQS に送り、Lambda のハンドラーがそれをデシリアライズして実行します。

### SQS を通常のワーカーで処理する

`guren queue:work` でも、`SqsDriver` を通して SQS のジョブを処理できます。標準のアダプターは `ApproximateReceiveCount` を取得するので、再配信やワーカーの再起動があっても試行回数が引き継がれます。成功したジョブと `maxAttempts` に達したジョブは SQS から削除するため、ワーカーには `sqs:DeleteMessage` の権限が必要です。失敗の記録はプロセスのメモリに置かれるので、再起動後も残したい場合は、アプリ側で監視や永続的なエラー記録を用意してください。最終的に失敗したジョブは削除され、SQS のデッドレターキューには移りません。

通常のワーカーで独自のアダプターを使う場合は、`deleteMessage({ queueUrl, receiptHandle })` を実装し、`receiveMessage()` から SQS の `ApproximateReceiveCount` に基づく `receiveCount` を返してください。どちらかが欠けたアダプターは警告を 1 回出し、以前と同じ動きになります。つまり、処理を終えたジョブがキューに残り、試行回数は再配信のたびにメッセージ本文の値から数え直しになります。ジョブの送信だけに使うアダプターなら、どちらも不要です。`MessageSystemAttributeNames` が API に届くのは、このパラメーターに対応した `@aws-sdk/client-sqs`（3.577.0 以降）を使っている場合だけで、それより古いクライアントでは同じ警告が出ます。Lambda のイベントソースから処理する場合は、これまでどおり `createSqsHandler()` と AWS のバッチ処理結果の仕組みを使います。

### スケジュール — `createScheduleHandler(scheduler)`

EventBridge から呼び出されたときに、実行時刻を迎えたタスクを処理します。このハンドラーは `rate(1 minute)` の EventBridge ルールで起動してください。既存の `Scheduler` とタスク定義は、変更せずにそのまま動きます。

### コンソール — `createConsoleHandler(kernel)`

アプリの `ConsoleKernel`（`src/console.ts` が `kernel` として export しているもの）に登録したコマンドを実行します。コマンドの定義と登録の方法は [コンソールコマンドガイド](./console.md) を参照してください。

雛形の `src/lambda.ts` で `console` の export のコメントを外すと、ハンドラが有効になります。

カーネルには組み込みのコマンドがありません。マイグレーション用のコマンドが必要になるのは Data API アダプタを使う場合だけです（Data API アダプタの `getDatabase()` は、未適用のマイグレーションを意図的に実行しません。ほかのアダプタは初回利用時に適用します）。このトレードオフと `migrateOnStart` については [Aurora Serverless の項](./database.md#aurora-serverlessaws-data-apiサポート) を参照してください。どのアダプタでも、マイグレーションを別に実行しておけば、その待ち時間がリクエストの処理にかかりません。

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

`make:command` を実行すると、`src/console.ts` に書く登録行が表示されます。登録したら、AWS CLI から呼び出します。

```bash
aws lambda invoke --function-name my-app-console \
  --cli-binary-format raw-in-base64-out \
  --payload '{"command": "db:migrate"}' response.json
```

成功すると `{ exitCode: 0 }`、失敗すると `{ exitCode: 1 }` が返ります。

## サーバーサイドレンダリング

SSR は、追加の設定なしで Lambda 上で動きます。`lambda:build` が Vite の SSR バンドルを関数のディレクトリにコピーし、その場所をバンドルに埋め込むので、サーバーは最初に Inertia でレンダリングするときにレンダラーを読み込みます。SSR のビルドがないアプリは CSR だけの関数になります。どちらの場合もフラグは要りません。

## データベース

### Aurora Serverless v2 + RDS Data API（推奨）

Data API は HTTP で通信するので、コネクションプールも RDS Proxy も要らず、関数を VPC に置く必要もありません。使うのは `createAwsDataApiDatabase` です。

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

ドライバも一緒にインストールしてください（`bun add @aws-sdk/client-rds-data`）。関数には、クラスターに対する `rds-data` のアクションと、シークレットに対する `secretsmanager:GetSecretValue` の権限が必要です。後述する CDK コンストラクトの `dataApi` オプションを使えば、どちらも設定されます。認証には関数の IAM ロールを使います。`drizzle-kit generate`/`push` を使うときは、`drizzle.config.ts` で `driver: 'aws-data-api'` を設定します。

ファクトリの詳細は[データベースガイド](./database.md)を参照してください。

### 従来の RDS + RDS Proxy

関数を VPC 内で動かすなら、`createPostgresDatabase` で RDS に接続できます。接続は RDS Proxy を経由させ、プリペアドステートメントは無効にしてください。有効のままだと、プロキシでセッションピニングが起きます。

```typescript
// config/database.ts
import { createPostgresDatabase } from '@guren/core'
import env from './env.js'

const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  connectionString: (context) => (context?.env ?? env.parse(undefined, { mode: 'report' }).values).DATABASE_URL,
  clientOptions: { prepare: false, max: 1 },
})
```

このリゾルバは、アプリの起動時には検証済みの環境変数を受け取ります。アプリの外から `guren db:migrate` に呼ばれたときは、自分でスキーマを解析します（[データベース接続](./configuration.md#データベース接続)）。

### 使うクライアントだけがバンドルされる

ORM は各ダイアレクトのクライアントを動的 import で読み込みますが、バンドラーはその分岐が実際に通るかどうかに関係なく import をたどります。そのため何も手を打たないと、Postgres のアプリが、選んでもいない `mysql2` を解決できずにビルドに失敗します。そこでビルドは、`config/database.ts` がどのファクトリを呼んでいるかを読み取り、ほかのダイアレクトのクライアントを、到達したら例外を投げるスタブに差し替えています。

読み取るのは `config/database.ts`（または `db/config.ts`）だけです。別の場所で 2 つ目の接続を開いているアプリでは、使うデータベースを明示してください。再 export や別モジュールを経由するなど、config にファクトリの名前が現れない書き方をしている場合も同じです（この場合、ビルドは「判別できなかった」と報告し、何もスタブにしません）。

```bash
bunx guren lambda:build --database postgres,sqlite
```

## ランタイム検出

実行中のランタイムに応じて、サービスの設定を切り替えられます。

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

デフォルトのハッシャーは、どのランタイムでも `node:crypto` の scrypt でハッシュを書き込みます。ローカルの Bun で投入したカラムも、Lambda でそのまま検証できます。新しいアプリなら設定は要りません。

> [!WARNING]
> Argon2id で書かれた行は、`Bun.password` がある環境でしか検証できません。`hasher: 'argon2'` を選んだアプリと、scrypt が既定になる前のリリースで投入したカラムがこれにあたります。移行の手順は[パスワードハッシャー](/docs/guides/authentication#パスワードハッシャー)で説明しています。Lambda に移す前に済ませてください。

## ロギング

Lambda は `stderr` を自動で CloudWatch に送ります。ログはコンソールに JSON 形式で出すようにしてください。

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

Lambda は静的ファイルの配信には向いていません。`lambda:build` が `public/` を S3 向けに `.lambda/assets` へステージングし、CDK コンストラクト（後述）が S3 バケットと、その前に置く CloudFront ディストリビューションをプロビジョニングします（デフォルトのオリジンはアプリです）。バケットへ振り分けられるのは `/public/*` と、`.lambda/assets` の直下にある各エントリ（`/robots.txt` など）です。ビルド済みのクライアントアセットは `/public/assets/` から配信されます。

これらのファイルには関数より先にディストリビューションが応答するので、フレームワークが自分で `public/` を配信するときに効かせているガードは働きません。そこでコンストラクトは、アセット向けのビヘイビアに viewer-response の CloudFront Function を付けて、同じガードを掛け直しています。ブラウザがドキュメントとして描画する形式 (`.html`、`.htm`、`.svg`、`.xhtml`、`.xml`) には、どの階層にあっても、拡張子が大文字でも小文字でも、`Content-Disposition: attachment` と `X-Content-Type-Options: nosniff` が付きます。画像、スクリプト、スタイルシート、フォントには手を加えず、デフォルトのビヘイビア (つまりアプリ) のヘッダーもアプリが返すままです。

アセットを手動でデプロイする場合は、`.lambda/assets` をバケットに同期し、関数の `GUREN_INERTIA_ENTRY` / `GUREN_INERTIA_STYLES` に CDN の URL を設定してください（設定する値は `.lambda/env.json` に載っています）。ただし、上で説明したドキュメント向けのルールは、ステージングしたディレクトリではなく CDK コンストラクトに含まれています。自前で用意したディストリビューションでは、`public/` の `.svg` がアプリのオリジン上でインラインに描画されます。

## 設定上の注意

### サービスプロバイダ

バンドルには走査できるディレクトリがないので、アプリが登録するものはすべて `createApp()` に書きます。サービスは config 定義として `config` に、まだ残っているプロバイダは `providers` に並べてください。

```typescript
const app = createApp({
  env,
  config: [database, http, session, cache, queue],
  providers: [SessionDriversProvider],
  routes: registerWebRoutes,
})
```

### マイグレーションとシード

雛形の `config/database.ts` は、ローカル開発の手間を省くために起動時にシードを実行し（`seedOnBoot: process.env.NODE_ENV !== 'production'`）、本番ではスキップします。このガードは外さないでください。Lambda はコールドスタートのたびにアプリを起動するので、起動時のシードが本番データに対して何度も実行されてしまいます。

**マイグレーションは関数に同梱されます。** `lambda:build` が `db/migrations/` をバンドルの隣にコピーするので、`db:migrate` のコンソールコマンドを使えばその場で適用できます。コマンドの定義と呼び出し方は [コンソールハンドラ `createConsoleHandler(kernel)`](#コンソール--createconsolehandlerkernel) を参照してください。

**シーダーは関数の中では実行できません。** シーダーはスキーマや `@guren/core` を import するふつうの `.ts` モジュールですが、デプロイされる関数は `node_modules` も TypeScript のローダーも持たない自己完結したバンドルなので、Node.js のランタイムはシーダーを読み込めません。シードは、プロジェクトのソースがある環境から実行してください。

```bash
DATABASE_URL='<本番の接続文字列>' bunx guren db:seed --force
```

手動で適用するのではなくリリースに含めたいデータは、マイグレーションとして書いておけば関数と一緒に配布されます。

### ストレージとファイルシステム

Lambda のファイルシステムは、`/tmp`（512 MB、一時的）を除いて読み取り専用です。`/tmp` は一時的なキャッシュにだけ使い、永続的なストレージには `S3Driver` を通して S3 を使ってください。

### セッションとキャッシュ

インメモリのストアは呼び出しのたびに失われるので、セッションには Lambda の呼び出しをまたいでデータが残るバックエンドが必要です。

`bunx guren add session` を実行し、`config/session.ts` でストアを選んでください。たいていのアプリには `database` をおすすめします。アプリがすでに接続しているデータベースにセッションを保存するので追加のインフラは要らず、`createScheduleHandler` でスケジュールした `sessions:prune` がテーブルを小さく保ってくれます。

### DynamoDB

セッションの頻繁な書き込みをプライマリの DB から逃がしたい場合は、`@guren/plugin-lambda` が追加する `dynamodb` ドライバを使えます。

```bash
bun add @aws-sdk/client-dynamodb
```

```typescript
// config/session.ts
import { defineSessionConfig } from '@guren/core'
import { sessions } from '../db/schema.js'

export default defineSessionConfig((env) => ({
  default: env.SESSION_DRIVER,
  stores: {
    database: { driver: 'database', table: sessions },
    dynamodb: { driver: 'dynamodb' },
  },
}))
```

`config/session.ts` ではストアに名前を付けられますが、ドライバの登録まではできません。バインドされたマネージャへのドライバの追加は、プロバイダの `register()` で行います。

```typescript
// app/Providers/SessionDriversProvider.ts
import { ServiceProvider } from '@guren/core'
import { registerDynamoDbSessionDriver } from '@guren/plugin-lambda'

export default class SessionDriversProvider extends ServiceProvider {
  register(): void {
    registerDynamoDbSessionDriver(this.container.make('session'))
  }
}
```

`session` を `createApp({ config })` に、このプロバイダを `providers` に加え、関数に `SESSION_DRIVER=dynamodb` を設定します。定義はどのプロバイダの登録よりも先にバインドされ、セッションマネージャはストアを必要になった時点で解決します。そのため、デフォルトのストアのドライバが存在するかを起動時に確かめる時点では、ドライバはもう登録されています。`boot()` で登録すると、この確認に間に合いません。

テーブル名は `DYNAMODB_SESSIONS_TABLE` から読みます。この変数は CDK コンストラクトの `sessionsTable` がすべての関数に設定します。自分で指定したい場合は、ストアの設定に `table` を渡してください。登録を import の副作用ではなく関数呼び出しにしているのは、使われていない import を削除するバンドラーに、ドライバまで一緒に削除されないようにするためです。

テーブルには、文字列のパーティションキー `id` と、`expires_at` に対する TTL の設定が必要です。読み取りは強い整合性で行うので、ログイン時に書き込んだセッションは、その直後のリダイレクトで確実に読めます。DynamoDB の TTL は期限が来た瞬間ではなく 48 時間以内にアイテムを削除するため、ストア自身も `expires_at` を過ぎたセッションは存在しないものとして扱います。TTL はあくまで後片付けの仕組みで、期限の判定には使っていません。DynamoDB のアイテムは 400 KB までなので、セッションには id だけを入れてください。

`redis` ドライバ（ElastiCache）も引き続き選べます。キャッシュには Redis や DynamoDB が向いています（下のインフラの表を参照してください）。

## インフラ推奨構成

| 項目 | 推奨 |
|------|------|
| **HTTP トリガー** | API Gateway v2（HTTP API）または ALB |
| **データベース** | Aurora Serverless v2 + Data API（`createAwsDataApiDatabase`）、または RDS + RDS Proxy |
| **セッション** | `database` ドライバ（追加のインフラ不要）。セッションの負荷が高い場合は `dynamodb`（コンストラクトの `sessionsTable`）や `redis`（ElastiCache） |
| **キャッシュ** | `RedisCacheStore` を使った Redis（`@guren/core/redis` にはセッション、レート制限、API トークンのストアも入っています）。一時的なキャッシュなら `/tmp` + `FileStore` |
| **キュー** | SQS（`SqsDriver` + `createSqsHandler()`） |
| **スケジューリング** | EventBridge + `createScheduleHandler()` |
| **CLI コマンド** | 専用の Lambda + `createConsoleHandler()` |
| **静的アセット** | CloudFront + S3（CDK コンストラクトがプロビジョニング） |
| **ロギング** | CloudWatch（stderr、JSON 形式） |

## CDK でデプロイ

プラグインには、構成全体をまとめて組み立てる CDK コンストラクトが入っています。HTTP API、デッドレターキューと部分的なバッチ失敗に対応したキューワーカー、EventBridge ルール、コンソール用の関数、アセット用の CloudFront + S3 がこれで揃います。

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

各サブリソースはプロパティ（`httpFunction`、`queue`、`distribution` など）として公開されているので、カスタムドメインをつないだり、IAM 権限を足したり、関数ごとにメモリを調整したりできます。そのままデプロイできる CDK アプリの全体は[デプロイレシピ](https://github.com/gurenjs/guren/tree/main/examples/deploy/serverless)にあります。

```bash
bunx guren lambda:build
bunx cdk deploy
```

> [!WARNING]
> `lambda:build` の代わりに自前のバンドラーを使う場合は、識別子のマングリングを無効にしてください。Guren は永続的なレコードにクラス名を保存しています。キューに入れたジョブには wire name（既定はクラス名）が、永続化した通知には通知の種別が、HTTP 例外には例外自身の名前が入ります。マングルしたビルドでは、前回のデプロイが書き込んだレコードを解決できなくなります。`bun build` では `--minify` ではなく `--minify-whitespace --minify-syntax --keep-names` を指定してください。`register(class SendWelcomeMail extends Job {})` のような名前付きクラス式の名前は構文の minify で消えてしまうため、`--keep-names` で残します。`esbuild` では `keepNames: true` を指定してください。`minify: true` と一緒に使ってもすべての名前が残ります。`minifyIdentifiers: false` だけでは、Bun の構文の minify と同じ名前が失われます。`tsdown` / `rolldown` では `mangle: false` だけでは足りません(compress が 1 か所でしか使われないクラスを無名のクラス式としてインライン化するので、`name` が `""` になります)。`minify: true` の代わりに `minify: { compress: { keepNames: { class: true, function: true } }, mangle: false }` を指定します。Bun では、`--keep-names` / `minify.keepNames` を付けても `--minify` は安全になりません。Bun 1.3.14 と 1.4.2 のどちらでも、識別子の minify を有効にするとクラス名がマングルされます。また、別のモジュールが同じトップレベルの名前を宣言していると、Bun はクラス名を変えます。2 つある `OrderShipped` の片方が `OrderShipped2` になり、どちらが変わるかは import の順で決まります。これを防ぐフラグはないので、クラス名を分けるか、後述の方法で名前を固定してください。`keepNames` を設定する `@guren/plugin-lambda` のリリースに更新すれば、`lambda:build` がここまでの対策をすべて行い、ジョブ・イベント・通知・エージェント・モデルの名前が変わるときは警告を出します。名前が変わったモデルは、クラス名を変更してください。添付ファイルとポリモーフィック関連はバンドル後の名前で保存されますが、`Model.morphMap` はその名前を知らないためです。
>
> どうしてもマングルする場合は、すべてのジョブに `jobName` を、すべての通知に明示的な `type` を宣言し、永続レコードに残る識別子をクラス名から切り離してください（[ジョブ名を固定する](./queue.md#ジョブ名を固定する) を参照）。どちらも宣言しなければクラス名が既定値になり、例外の名前は常にクラス名から決まります。識別子をそのまま残しておくほうが安全であることに変わりはありません。

# サーバーレスデプロイ（AWS Lambda）

`@guren/core/lambda` アダプターで Guren を AWS Lambda 上で動かせます。このガイドでは HTTP、キュー、スケジュールタスク、CLI コマンド、インフラ構成のすべてをカバーします。

## 完全な Lambda エントリポイント

1つの `lambda.ts` ファイルで全 Lambda 関数のハンドラーを export できます:

```typescript
import app from './src/app'
import {
  createLambdaHandler,
  createSqsHandler,
  createScheduleHandler,
  createConsoleHandler,
} from '@guren/core/lambda'
import { scheduler } from './src/scheduler'
import { kernel } from './src/console'

await app.boot()

// HTTP リクエスト（API Gateway / ALB 経由）
export const http = createLambdaHandler(app)

// SQS キュージョブ処理
export const queue = createSqsHandler()

// EventBridge スケジュールタスク
export const schedule = createScheduleHandler(scheduler)

// CLI コマンド（マイグレーション、シード等）
export const console = createConsoleHandler(kernel)
```

`app.boot()` はコールドスタート時に1回実行されます。全ハンドラーがブート済みのアプリインスタンスを共有します。

## ハンドラー

### HTTP — `createLambdaHandler(app)`

Hono の fetch ハンドラーを API Gateway v1/v2、ALB 向けにラップします。ルート、コントローラー、ミドルウェアはサーバーフル構成と同じように動作します。

### キュー — `createSqsHandler()`

SQS メッセージを Guren のジョブとして処理します。**部分バッチ失敗**に対応しており、失敗したメッセージのみが SQS に戻されてリトライされます。

キュープロバイダーで SQS ドライバーを設定:

```typescript
import { SQSClient } from '@aws-sdk/client-sqs'
import { createSqsAdapter, SqsDriver, setQueueDriver } from '@guren/core/queue'

const adapter = createSqsAdapter(new SQSClient({ region: 'ap-northeast-1' }))
setQueueDriver(new SqsDriver(adapter, {
  queueUrl: process.env.SQS_QUEUE_URL!,
  // オプション: 論理キュー名を個別の SQS URL にマッピング
  queueUrls: {
    emails: process.env.SQS_EMAILS_QUEUE_URL!,
  },
}))
```

ジョブの dispatch はサーバーと同じです — `await SendEmailJob.dispatch({ to: 'user@example.com' })`。`SqsDriver` がジョブを SQS にシリアライズし、Lambda ハンドラーがデシリアライズして実行します。

### スケジュール — `createScheduleHandler(scheduler)`

EventBridge から呼び出されたときにタスクを実行します。EventBridge ルールを `rate(1 minute)` で設定してください。既存の `Scheduler` とタスク定義は変更なしで動作します。

### コンソール — `createConsoleHandler(kernel)`

Lambda 上で CLI コマンドを実行します。AWS CLI で呼び出し:

```bash
aws lambda invoke --function-name my-app-console \
  --payload '{"command": "db:migrate"}' response.json
```

成功時は `{ exitCode: 0 }`、失敗時は `{ exitCode: 1 }` を返します。

## ランタイム検出

ランタイムに応じた設定の切り替え:

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

デフォルトの `ScryptHasher` は `Bun.password` を使うため Lambda では動作しません。`NodeHasher` を使います:

```typescript
import { NodeHasher } from '@guren/core/auth'

// AuthProvider 内で:
container.instance('hash', new NodeHasher())
```

> [!WARNING]
> `ScryptHasher`（Bun の Argon2/bcrypt）と `NodeHasher`（Node.js の scrypt）はハッシュ形式が異なります。既存アプリの移行時はパスワードの再ハッシュが必要です。

## ロギング

Lambda は `stderr` を自動で CloudWatch に送信します。JSON 形式のコンソールロギングを使います:

```typescript
import { LogManager } from '@guren/core/logging'

const log = new LogManager({
  default: 'console',
  channels: {
    console: { driver: 'console', level: 'info', format: 'json', colors: false },
  },
})
```

## 静的アセット

Lambda での静的ファイル配信は適していません。CloudFront + S3 を使います:

1. Vite ビルド出力（`public/assets/`）を S3 バケットにアップロード。
2. そのバケットを参照する CloudFront ディストリビューションを作成。
3. `GUREN_INERTIA_ENTRY_URL` と `GUREN_INERTIA_STYLES_URL` に CloudFront の URL を設定。

## 設定上の注意

### サービスプロバイダー

オートディスカバリー（`Bun.Glob`）は Lambda では利用不可。プロバイダーを明示的に列挙してください:

```typescript
const app = createApp({
  providers: [
    DatabaseProvider,
    AuthProvider,
    CacheProvider,
    // ... すべてのプロバイダー
  ],
  routes: registerRoutes,
})
```

### ストレージ・ファイルシステム

Lambda のファイルシステムは `/tmp`（512 MB、揮発性）以外は読み取り専用です。`/tmp` は一時キャッシュのみに使用。永続ストレージには `S3Driver` 経由の S3 を使ってください。

### セッション・キャッシュ

インメモリストアはリクエスト間で失われます。セッションとキャッシュには Redis（ElastiCache）または DynamoDB を使ってください。

## インフラ構成の推奨

| 項目 | 推奨 |
|------|------|
| **HTTP トリガー** | API Gateway v2（HTTP API）または ALB |
| **セッション** | Redis（ElastiCache）— インメモリは不可 |
| **キャッシュ** | `RedisStore` 経由の Redis、または `FileStore` で `/tmp`（揮発性キャッシュ） |
| **キュー** | `SqsDriver` + `createSqsHandler()` 経由の SQS |
| **データベース** | RDS PostgreSQL + RDS Proxy（コネクションプーリング） |
| **スケジューリング** | EventBridge + `createScheduleHandler()` |
| **CLI コマンド** | 専用 Lambda + `createConsoleHandler()` |
| **静的アセット** | CloudFront + S3 |
| **ロギング** | CloudWatch（stderr、JSON 形式） |

## AWS CDK の例

4つの Lambda 関数を含む完全な CDK スタック:

```typescript
import { Duration, Stack } from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as sqsEventSources from 'aws-cdk-lib/aws-lambda-event-sources'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'

const code = lambda.Code.fromAsset('dist')
const runtime = lambda.Runtime.NODEJS_22_X
const environment = {
  NODE_ENV: 'production',
  DATABASE_URL: '...',
  SQS_QUEUE_URL: '', // 下で設定
}

// --- HTTP ---
const httpFn = new lambda.Function(this, 'Http', {
  runtime,
  handler: 'lambda.http',
  code,
  timeout: Duration.seconds(30),
  memorySize: 512,
  environment,
})

const api = new apigw.HttpApi(this, 'Api')
api.addRoutes({
  path: '/{proxy+}',
  integration: new HttpLambdaIntegration('HttpIntegration', httpFn),
})

// --- キュー ---
const queue = new sqs.Queue(this, 'JobQueue', {
  visibilityTimeout: Duration.seconds(60),
  deadLetterQueue: {
    queue: new sqs.Queue(this, 'JobDLQ'),
    maxReceiveCount: 3,
  },
})

environment.SQS_QUEUE_URL = queue.queueUrl

const queueFn = new lambda.Function(this, 'QueueWorker', {
  runtime,
  handler: 'lambda.queue',
  code,
  timeout: Duration.seconds(60),
  memorySize: 512,
  environment,
})

queueFn.addEventSource(
  new sqsEventSources.SqsEventSource(queue, {
    batchSize: 10,
    reportBatchItemFailures: true,
  }),
)

// --- スケジューラー ---
const scheduleFn = new lambda.Function(this, 'Scheduler', {
  runtime,
  handler: 'lambda.schedule',
  code,
  timeout: Duration.seconds(60),
  memorySize: 256,
  environment,
})

new events.Rule(this, 'ScheduleRule', {
  schedule: events.Schedule.rate(Duration.minutes(1)),
  targets: [new targets.LambdaFunction(scheduleFn)],
})

// --- コンソール ---
const consoleFn = new lambda.Function(this, 'Console', {
  runtime,
  handler: 'lambda.console',
  code,
  timeout: Duration.minutes(5),
  memorySize: 512,
  environment,
})
```

> [!NOTE]
> Lambda にデプロイする前に、`esbuild` や `tsup` でアプリをバンドルしてください。すべての依存がデプロイパッケージに含まれていることを確認してください。

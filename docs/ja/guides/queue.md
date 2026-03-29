# キューガイド

Guren は、時間のかかるタスクをバックグラウンドで処理するための堅牢なキューシステムを提供します。これは、メール送信、アップロード処理、外部API呼び出しなどの操作を行いながら、高速なレスポンスタイムを維持するために不可欠です。

推奨パターン: `@guren/core` から queue API をインポートし、provider で queue manager を構成します。コントローラーではジョブのディスパッチに集中します。

## コアコンセプト

- **Job** – 非同期で処理される作業単位をカプセル化したクラス。`handle()`メソッドを定義し、リトライ動作を指定できます。
- **Worker** – キューからジョブを取得して実行する長時間実行プロセス。リトライ、失敗、グレースフルシャットダウンを処理します。
- **Driver** – ジョブのストレージバックエンド。GurenにはMemoryとRedisドライバが付属しています。
- **QueueManager** – 複数のキュードライバを設定・アクセスするための中央レジストリ。

## ジョブの作成

CLIを使用して新しいジョブを生成します。

```bash
bunx guren make:job SendWelcomeEmail
```

これにより`app/Jobs/SendWelcomeEmailJob.ts`が作成されます。

```ts
import { Job } from '@guren/core'

interface SendWelcomeEmailPayload {
  userId: string
  email: string
}

export class SendWelcomeEmailJob extends Job<SendWelcomeEmailPayload> {
  // キュー名（デフォルト: 'default'）
  static queue = 'emails'

  // 最大リトライ回数（デフォルト: 3）
  static maxAttempts = 5

  // バックオフ戦略: 'exponential' | 'linear' | number (ms)
  static backoff: 'exponential' | 'linear' | number = 'exponential'

  async handle({ userId, email }: SendWelcomeEmailPayload): Promise<void> {
    // ジョブのロジックをここに記述
    console.log(`${email}にウェルカムメールを送信中`)
    // await mailService.send(...)
  }

  // オプション: ジョブが完全に失敗した時に呼ばれる
  async failed({ userId, email }: SendWelcomeEmailPayload, error: Error): Promise<void> {
    console.error(`${email}へのウェルカムメール送信に失敗:`, error.message)
  }
}
```

### ジョブ設定

| プロパティ | デフォルト | 説明 |
|-----------|-----------|------|
| `queue` | `'default'` | このジョブタイプのキュー名 |
| `maxAttempts` | `3` | 失敗前の最大リトライ回数 |
| `backoff` | `'exponential'` | リトライ遅延戦略 |

**バックオフ戦略：**
- `'exponential'`: 2^attempt × 1000ms (1秒, 2秒, 4秒, 8秒, ...)
- `'linear'`: attempt × 1000ms (1秒, 2秒, 3秒, ...)
- `number`: ミリ秒単位の固定遅延

## ジョブのディスパッチ

### ファサードを使用（推奨）

`QueueManager` を使うと、コンテナからキュードライバを遅延解決してシンプルにジョブをディスパッチできます。

```ts
// Resolve the queue manager from the container
const Queue = app.container.make('queue')

await Queue.push(new SendWelcomeEmailJob({
  userId: '123',
  email: 'user@example.com',
}))
```

### 直接セットアップ

ジョブをディスパッチする前に、キューマネージャーを設定します。

```ts
import { createQueueManager, MemoryDriver } from '@guren/core'

const queue = createQueueManager({
  default: 'memory',
  drivers: {
    memory: () => new MemoryDriver(),
  },
})

queue.driver()
```

その後、アプリケーションのどこからでもジョブをディスパッチできます。

```ts
import { SendWelcomeEmailJob } from '@/app/Jobs/SendWelcomeEmailJob'

// 即座にディスパッチ
await SendWelcomeEmailJob.dispatch({
  userId: '123',
  email: 'user@example.com',
})

// 遅延付きでディスパッチ（5分後）
await SendWelcomeEmailJob.dispatchAfter(5 * 60 * 1000, {
  userId: '123',
  email: 'user@example.com',
})

// オプション付きでディスパッチ
await SendWelcomeEmailJob.dispatch(
  { userId: '123', email: 'user@example.com' },
  {
    queue: 'high-priority',
    maxAttempts: 10,
    delay: 30000, // 30秒
  }
)
```

## ワーカーの実行

### CLIを使用

ジョブを処理するワーカーを起動します。

```bash
# デフォルトキューを処理
bunx guren queue:work

# 特定のキューを処理（優先度順）
bunx guren queue:work --queue=high-priority,default,emails

# カスタム設定で処理
bunx guren queue:work --sleep=500 --timeout=120000 --max-jobs=100
```

**CLIオプション：**

| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `--queue` | `default` | カンマ区切りのキュー名 |
| `--sleep` | `1000` | ジョブがない時のスリープ時間（ms） |
| `--timeout` | `60000` | ジョブのタイムアウト（ミリ秒） |
| `--max-jobs` | `0` | 停止前の最大ジョブ数（0 = 無制限） |

### コードによるワーカー

より細かい制御のために、コードからワーカーを作成できます。

```ts
import { Worker, MemoryDriver, createQueueManager, registerJob } from '@guren/core'
import { SendWelcomeEmailJob } from '@/app/Jobs/SendWelcomeEmailJob'

// セットアップ
const queue = createQueueManager({
  default: 'memory',
  drivers: {
    memory: () => new MemoryDriver(),
  },
})
const driver = queue.driver()

// ジョブクラスを登録（ワーカーがジョブを見つけるために必要）
registerJob(SendWelcomeEmailJob)

// ワーカーを作成して起動
const worker = new Worker(driver, {
  queues: ['high-priority', 'default', 'emails'],
  sleep: 1000,
  timeout: 60000,
  maxJobs: 0,        // 0 = 無制限
  stopWhenEmpty: false,
}, {
  // オプションのイベントハンドラ
  jobProcessed: (job) => console.log(`処理完了: ${job.name}`),
  jobFailed: (job, error, willRetry) => {
    console.error(`失敗: ${job.name}`, error.message, willRetry ? '(リトライ予定)' : '')
  },
  workerStarted: () => console.log('ワーカー開始'),
  workerStopped: () => console.log('ワーカー停止'),
})

// 処理を開始
await worker.start()

// グレースフルシャットダウン（現在のジョブ完了を待機）
await worker.stop()
```

## 設定

### QueueManagerを使用

複数のキューバックエンドを持つアプリケーションには、`createQueueManager()` を使用します。

```ts
import { createQueueManager, MemoryDriver, RedisDriver, createRedisClient } from '@guren/core'

const redis = createRedisClient({ url: process.env.REDIS_URL })

const queueManager = createQueueManager({
  default: 'redis',
  drivers: {
    memory: () => new MemoryDriver(),
    redis: () => new RedisDriver(redis),
  },
})

// デフォルトドライバを解決し、dispatch の既定ドライバとして有効化
const driver = queueManager.driver()

// 特定のドライバを取得
const memoryDriver = queueManager.driver('memory')
```

### Redisドライバ

本番環境では、永続性とマルチサーバーサポートのためにRedisドライバを使用します。

```ts
import { createQueueManager, RedisDriver, createRedisClient } from '@guren/core'

const redis = createRedisClient({
  url: process.env.REDIS_URL,
})

const queue = createQueueManager({
  default: 'redis',
  drivers: {
    redis: () =>
      new RedisDriver(redis, {
        prefix: 'myapp:queue:', // キープレフィックス（デフォルト: 'guren:queue:'）
      }),
  },
})

const driver = queue.driver()
```

## 失敗したジョブ

`maxAttempts`を超えたジョブは、失敗ジョブストアに移動されます。

### 失敗したジョブの表示

```bash
bunx guren queue:failed
```

またはコードから取得できます。

```ts
const failedJobs = await driver.getFailedJobs()
// またはキューでフィルタ
const failedEmails = await driver.getFailedJobs('emails')
```

### 失敗したジョブのリトライ

```bash
# 特定のジョブをリトライ
bunx guren queue:retry <job-id>

# 全ての失敗したジョブをリトライ
bunx guren queue:retry --all
```

またはコードからリトライできます。

```ts
await driver.retryFailedJob(jobId)
```

### 失敗したジョブのクリア

```bash
bunx guren queue:flush
```

またはコードから削除できます。

```ts
await driver.deleteFailedJob(jobId)
```

## テスト

テストには、Memoryドライバを使用してジョブを同期的に処理します。

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { MemoryDriver, createQueueManager, registerJob, processJob, clearJobRegistry } from '@guren/core'
import { SendWelcomeEmailJob } from '@/app/Jobs/SendWelcomeEmailJob'

describe('SendWelcomeEmailJob', () => {
  let driver: MemoryDriver

  beforeEach(() => {
    const queue = createQueueManager({
      default: 'memory',
      drivers: {
        memory: () => new MemoryDriver(),
      },
    })
    driver = queue.driver()
    clearJobRegistry()
    registerJob(SendWelcomeEmailJob)
  })

  test('ジョブが正常に処理される', async () => {
    // ジョブをディスパッチ
    await SendWelcomeEmailJob.dispatch({
      userId: '123',
      email: 'test@example.com',
    })

    // ジョブがキューに入っていることを確認
    expect(await driver.size('emails')).toBe(1)

    // ジョブを処理
    const processed = await processJob(driver, 'emails')
    expect(processed).toBe(true)

    // キューが空であることを確認
    expect(await driver.size('emails')).toBe(0)
  })
})
```

## ベストプラクティス

1. **型付きペイロードを使用**: ジョブペイロードにインターフェースを定義して型安全性を確保。

2. **ジョブは単一責任に**: 各ジョブは1つのことをうまく行うべき。複雑なワークフローには複数のジョブをチェーン。

3. **失敗を適切に処理**: `failed()`メソッドを実装してエラーをログ、アラート送信、クリーンアップを行う。

4. **適切なキューを使用**: 優先度やタイプでキューを分離（例：`emails`、`exports`、`notifications`）。

5. **適切なタイムアウトを設定**: 長時間実行ジョブには適切な`timeout`値を設定。

6. **キューサイズを監視**: キューのバックログを追跡してボトルネックを特定。

7. **ジョブロジックをテスト**: ジョブハンドラのユニットテストを書いて本番前にエラーを検出。

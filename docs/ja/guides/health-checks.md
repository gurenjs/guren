# ヘルスチェック

Guren のヘルスチェックを使うと、アプリケーションが依存しているサービスの状態をまとめて監視できます。ロードバランサーやオーケストレーター、監視ツールから見える `/health` エンドポイントを用意するときに使います。

## 設定

ヘルスマネージャーを作り、そこにチェックを登録します。

```typescript
import { createHealthManager, DatabaseCheck, RedisCheck, MemoryCheck } from '@guren/core'

const health = createHealthManager()

// チェックを登録
health.register(new DatabaseCheck(db))
health.register(new RedisCheck(redis))
health.register(new MemoryCheck({ thresholdMb: 512 }))

// すべてのチェックを実行
const report = await health.check()
console.log(report.status) // 'healthy', 'degraded', または 'unhealthy'
```

## 組み込みチェック

### データベースチェック

単純なクエリを投げて、データベース接続を確かめます。

```typescript
import { DatabaseCheck } from '@guren/core'

// 基本的な使用方法
health.register(new DatabaseCheck(db))

// カスタムオプション付き
health.register(new DatabaseCheck(db, {
  name: 'mysql',           // カスタム名（デフォルト: 'database'）
  query: 'SELECT 1 + 1',   // カスタムクエリ（デフォルト: 'SELECT 1'）
}))
```

### Redisチェック

Redis への接続を確かめます。

```typescript
import { RedisCheck } from '@guren/core'

// 基本的な使用方法
health.register(new RedisCheck(redis))

// カスタムオプション付き
health.register(new RedisCheck(redis, {
  name: 'redis-cache',   // カスタム名（デフォルト: 'redis'）
}))
```

### メモリチェック

プロセスのメモリ使用量が、指定したしきい値を超えていないかを監視します。

```typescript
import { MemoryCheck } from '@guren/core'

health.register(new MemoryCheck({
  name: 'memory',              // チェック名（デフォルト: 'memory'）
  thresholdMb: 512,            // 警告しきい値（デフォルト: 512）
  criticalThresholdMb: 1024,   // 危険しきい値（デフォルト: 1024）
}))
```

メモリチェックは、ヒープの使用量に応じて次のステータスを返します。
- **healthy**（正常）: 警告しきい値未満
- **degraded**（機能低下）: 警告しきい値以上、危険しきい値未満
- **unhealthy**（異常）: 危険しきい値以上

### キャッシュチェック

`CacheStore` にキーを 1 つ書き込み、読み戻してから削除します。コンストラクタには、マネージャではなくストア本体（`CacheManager` の `cache.store()`、または自作のストア）を渡してください。

```typescript
import { CacheCheck } from '@guren/core'

const cache = app.container.make('cache') // CacheManager

health.register(new CacheCheck(cache.store(), {
  name: 'cache',   // カスタム名（デフォルト: 'cache'）
}))
```

以前の `get` / `put` / `forget` の形で書いたオブジェクトは、コンストラクタの型に合わないのでコンパイルが通りません。実行した場合も、チェックが呼び出すメソッドが存在しないため `unhealthy` になります。`StorageCheck` も同じように `StorageDriver` を受け取り、その `put` は保存先のパスを返す必要があります。

### ストレージチェック

`StorageDriver` にファイルを 1 つ書き込み、読み戻してから削除します。コンストラクタには、マネージャではなくディスク本体（`StorageManager` の `storage.disk()`、または自作のドライバ）を渡してください。

```typescript
import { StorageCheck } from '@guren/core'

const storage = app.container.make('storage') // StorageManager

health.register(new StorageCheck(storage.disk(), {
  name: 'storage',                    // カスタム名（デフォルト: 'storage'）
  testPath: '__health_check__.txt',   // テストファイルパス（デフォルト: '__health_check__.txt'）
}))
```

## カスタムチェック

### CustomCheckの使用

`customCheck()` にコールバック関数を渡すと、その場でチェックを作れます。

```typescript
import { customCheck } from '@guren/core'

// シンプルなカスタムチェック
health.register(customCheck('external-api', async () => {
  try {
    const response = await fetch('https://api.example.com/health')
    if (response.ok) {
      return { status: 'healthy', message: 'APIが応答しています' }
    }
    return { status: 'degraded', message: 'APIがエラーを返しました' }
  } catch (error) {
    return { status: 'unhealthy', message: 'APIに到達できません' }
  }
}))

// メタデータ付き
health.register(customCheck('queue-depth', async () => {
  const depth = await getQueueDepth()

  return {
    status: depth < 1000 ? 'healthy' : 'degraded',
    message: `キューに${depth}件のジョブがあります`,
    meta: { depth, maxDepth: 1000 },
  }
}))
```

### HealthCheckクラスの拡張

何度も使うチェックは、基底クラスの `HealthCheck` を継承したクラスとして書きます。

```typescript
import { HealthCheck, CheckResult } from '@guren/core'

export class ExternalServiceCheck extends HealthCheck {
  readonly name: string

  constructor(
    private url: string,
    private serviceName: string
  ) {
    super()
    this.name = serviceName
  }

  async check(): Promise<CheckResult> {
    try {
      const start = Date.now()
      const response = await fetch(this.url)
      const latency = Date.now() - start

      if (!response.ok) {
        return this.degraded(`サービスが${response.status}を返しました`, { latency })
      }

      if (latency > 1000) {
        return this.degraded('サービスの応答が遅いです', { latency })
      }

      return this.healthy('サービスは正常です', { latency })
    } catch (error) {
      return this.unhealthy(
        error instanceof Error ? error.message : 'サービスに到達できません'
      )
    }
  }
}

// 使用方法
health.register(new ExternalServiceCheck(
  'https://api.stripe.com/health',
  'stripe'
))
```

## チェックオプション

チェックを登録するときに、オプションを指定できます。

```typescript
health.register(check, {
  timeout: 5000,      // タイムアウト（ミリ秒、デフォルト: 5000）
  critical: true,     // trueの場合、失敗で全体がunhealthyになる
})
```

### クリティカル vs 非クリティカルチェック

- **クリティカルなチェック**: 異常（`unhealthy`）になると、全体のステータスも `unhealthy` になります
- **クリティカルでないチェック**: 異常になっても、全体のステータスは `degraded`（機能低下）にとどまります

```typescript
// データベースはクリティカル - なしではアプリが動作しない
health.register(new DatabaseCheck(db), { critical: true })

// キャッシュはあればよい - なくてもアプリは動作可能
health.register(new RedisCheck(redis), { critical: false })
```

## ヘルスレポート

`health.check()` を呼ぶと、次のようなレポートオブジェクトが返ります。

```typescript
const report = await health.check()

console.log(report)
// {
//   status: 'healthy' | 'degraded' | 'unhealthy',
//   timestamp: Date,
//   checks: [
//     {
//       name: 'database',
//       status: 'healthy',
//       message: 'データベース接続は正常です',
//       duration: 12,
//       meta: { ... }
//     },
//     // ...
//   ]
// }
```

### 特定のチェックを実行

```typescript
// 特定のチェックのみ実行
const report = await health.checkOnly(['database', 'redis'])

// 単一のチェック結果を取得
const dbResult = await health.getCheck('database')
```

## HTTPミドルウェア

組み込みのミドルウェアをルートに登録すると、ヘルスチェック用のエンドポイントを公開できます。

```typescript
import { createHealthManager } from '@guren/core'

const health = createHealthManager()
// ... チェックを登録

// ルートで
router.get('/health', health.middleware())

// オプション付き
router.get('/health', health.middleware({
  detailed: true,      // チェック詳細を含める（デフォルト: true）
  checks: ['database'] // 特定のチェックのみ実行
}))

// シンプルなエンドポイント（ステータスのみ）
router.get('/health/simple', health.middleware({ detailed: false }))
```

### レスポンス形式

**詳細レスポンス（`healthy` と `degraded` は 200 OK、`unhealthy` は 503）：**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "checks": [
    {
      "name": "database",
      "status": "healthy",
      "message": "データベース接続は正常です",
      "duration": 12,
      "meta": {}
    },
    {
      "name": "memory",
      "status": "healthy",
      "message": "メモリ使用量正常: 256MB",
      "duration": 1,
      "meta": {
        "usedMb": 256,
        "totalMb": 512,
        "thresholdMb": 512
      }
    }
  ]
}
```

**シンプルレスポンス：**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## CLIコマンド

### ヘルスチェック実行

ヘルスチェックはコマンドラインからも実行できます。

```bash
# すべてのヘルスチェックを実行
bunx guren health:check

# 特定のチェックを実行
bunx guren health:check --checks database,redis

# JSON形式で出力
bunx guren health:check --json
```

**出力：**
```
ヘルスチェックレポート
======================

ステータス: healthy
タイムスタンプ: 2024-01-15T10:30:00.000Z

チェック:
  [OK] database (12ms)
       データベース接続は正常です

  [OK] memory (1ms)
       メモリ使用量正常: 256MB

  [OK] redis (5ms)
       Redis接続は正常です

全体: 3/3 チェック成功
```

## 統合例

### 完全なセットアップ

```typescript
// app/health.ts
import {
  createHealthManager,
  DatabaseCheck,
  RedisCheck,
  MemoryCheck,
  customCheck,
} from '@guren/core'
import { db } from './database'
import { redis } from './redis'

export const health = createHealthManager()

// クリティカルチェック
health.register(new DatabaseCheck(db), { critical: true })

// 非クリティカルチェック
health.register(new RedisCheck(redis), { critical: false })
health.register(new MemoryCheck({
  thresholdMb: 512,
  criticalThresholdMb: 1024,
}))

// 外部API用カスタムチェック
health.register(customCheck('payment-api', async () => {
  const response = await fetch('https://api.stripe.com/health')
  return {
    status: response.ok ? 'healthy' : 'degraded',
    message: response.ok ? '決済APIは利用可能' : '決済APIに問題あり',
  }
}), { critical: false })
```

```typescript
// routes/api.ts
import { health } from '../app/health'

router.get('/health', health.middleware())
router.get('/health/live', health.middleware({ detailed: false }))
router.get('/health/ready', health.middleware({
  checks: ['database'],
  detailed: false,
}))
```

## ベストプラクティス

1. **liveness と readiness を分ける**: `/health/live` では基本的なチェックだけを、`/health/ready` ではすべてのチェックを実行します。
2. **データベースはクリティカルにする**: たいていのアプリは、データベースが無いと動きません。
3. **チェックは速く終わらせる**: タイムアウトを適切に設定し、時間のかかるチェックは避けてください。
4. **メタデータを添える**: 関連するメトリクスを入れておくと、デバッグが楽になります。
5. **オーケストレーターから使う**: Kubernetes や Docker は、このエンドポイントでコンテナの健全性を判定できます。
6. **機能低下（`degraded`）を監視する**: 異常（`unhealthy`）になる前の、機能低下の段階でアラートを出します。

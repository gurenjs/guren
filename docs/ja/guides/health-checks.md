# ヘルスチェック

Guren はアプリケーションの依存関係やサービスを監視するための包括的なヘルスチェックシステムを提供します。ロードバランサー、オーケストレーター、監視ツール向けに`/health`エンドポイントを公開するためにヘルスチェックを使用します。

## 設定

ヘルスマネージャーを作成し、チェックを登録します：

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

シンプルなクエリを実行してデータベース接続を検証します：

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

Redis接続を検証します：

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

設定可能なしきい値でプロセスメモリ使用量を監視します：

```typescript
import { MemoryCheck } from '@guren/core'

health.register(new MemoryCheck({
  name: 'memory',              // チェック名（デフォルト: 'memory'）
  thresholdMb: 512,            // 警告しきい値（デフォルト: 512）
  criticalThresholdMb: 1024,   // 危険しきい値（デフォルト: 1024）
}))
```

メモリチェックはヒープ使用量に基づいてステータスを返します：
- **healthy**: しきい値未満
- **degraded**: しきい値以上、危険値未満
- **unhealthy**: 危険しきい値以上

### キャッシュチェック

キャッシュストア接続を検証します：

```typescript
import { CacheCheck } from '@guren/core'

health.register(new CacheCheck(cache, {
  name: 'cache',   // カスタム名（デフォルト: 'cache'）
}))
```

### ストレージチェック

ストレージドライバー接続を検証します：

```typescript
import { StorageCheck } from '@guren/core'

health.register(new StorageCheck(storage, {
  name: 'storage',        // カスタム名（デフォルト: 'storage'）
  disk: 'local',          // チェックするディスク（デフォルト: デフォルトディスク）
  testPath: '.health',    // テストファイルパス（デフォルト: '.health'）
}))
```

## カスタムチェック

### CustomCheckの使用

コールバック関数でチェックを作成します：

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

再利用可能なチェックのために、基底クラスを拡張します：

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

チェックを登録する際にオプションを設定できます：

```typescript
health.register(check, {
  timeout: 5000,      // タイムアウト（ミリ秒、デフォルト: 5000）
  critical: true,     // trueの場合、失敗で全体がunhealthyになる
})
```

### クリティカル vs 非クリティカルチェック

- **クリティカルチェック**: unhealthyの場合、全体ステータスが「unhealthy」になる
- **非クリティカルチェック**: unhealthyの場合、全体ステータスが「degraded」になる

```typescript
// データベースはクリティカル - なしではアプリが動作しない
health.register(new DatabaseCheck(db), { critical: true })

// キャッシュはあればよい - なくてもアプリは動作可能
health.register(new RedisCheck(redis), { critical: false })
```

## ヘルスレポート

ヘルスチェックはレポートオブジェクトを返します：

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

組み込みのミドルウェアを使用してヘルスエンドポイントを公開します：

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

**詳細レスポンス（healthy/degradedは200 OK、unhealthyは503）：**

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

コマンドラインからヘルスチェックを実行します：

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

1. **livenessとreadinessを分離** - `/health/live`は基本チェック、`/health/ready`は完全なチェック用
2. **データベースをクリティカルにマーク** - 通常、なしではアプリが動作しません
3. **チェックを高速に保つ** - 適切なタイムアウトを設定し、遅いチェックを避ける
4. **メタデータを含める** - 関連メトリクスを含めてデバッグを支援
5. **オーケストレーターに使用** - Kubernetes/Dockerはコンテナヘルス用にヘルスエンドポイントを使用可能
6. **degraded状態を監視** - unhealthyになる前にdegradedステータスのアラートを設定

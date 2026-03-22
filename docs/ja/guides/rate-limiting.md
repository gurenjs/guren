# レート制限ガイド

Guren はアプリケーションを乱用から保護するための柔軟なレート制限システムを提供します。複数のストレージバックエンド、カスタムキージェネレーター、固定ウィンドウとスライディングウィンドウの両方のアルゴリズムをサポートしています。

## コアコンセプト

- **RateLimitStore** – レート制限データを保存するインターフェース。
- **MemoryRateLimitStore** – シングルプロセスアプリケーション用のインメモリストア。
- **SlidingWindowRateLimitStore** – より正確なスライディングウィンドウ実装。
- **レート制限ヘッダー** – クライアントフィードバック用の標準ヘッダー。

## 基本的な使い方

### クイックスタート

```ts
import { Router, createRateLimitMiddleware } from '@guren/core'

// すべてのルートに適用 - IPごとに1分間100リクエスト
const router = new Router()

router.middleware(createRateLimitMiddleware()).group((group) => {
  group.get('/api/*', [ApiController, 'handle'])
})
```

### ルート固有の制限

```ts
import { Router, createRateLimitMiddleware } from '@guren/core'

const router = new Router()

// ログインエンドポイントにより厳しい制限 - 15分間に5回の試行
router.post('/login', [AuthController, 'login']).middleware(
  createRateLimitMiddleware({
    limit: 5,
    windowMs: 15 * 60 * 1000, // 15分
  })
)

// 認証済みAPIルートにはより高い制限
router.middleware('auth').group((group) => {
  group.get('/api/*', [ApiController, 'handle']).middleware(
    createRateLimitMiddleware({
      limit: 1000,
      windowMs: 60 * 60 * 1000, // 1時間
    })
  )
})
```

## 設定オプション

```ts
interface RateLimitOptions {
  /** タイムウィンドウ内の最大リクエスト数（デフォルト: 100） */
  limit?: number

  /** タイムウィンドウ（ミリ秒、デフォルト: 60000 = 1分） */
  windowMs?: number

  /** リクエストからレート制限キーを抽出する関数 */
  keyGenerator?: (ctx: Context) => string | Promise<string>

  /** レート制限ストア実装 */
  store?: RateLimitStore

  /** 特定のリクエストのレート制限をスキップ */
  skip?: (ctx: Context) => boolean | Promise<boolean>

  /** レート制限超過時のカスタムハンドラー */
  onRateLimited?: (ctx: Context, retryAfter: number) => Response | Promise<Response>

  /** レスポンスにレート制限ヘッダーを追加（デフォルト: true） */
  headers?: boolean

  /** 制限時のエラーメッセージ（デフォルト: 'Too many requests...'） */
  message?: string

  /** 制限時のHTTPステータスコード（デフォルト: 429） */
  statusCode?: number

  /** レート制限キーのプレフィックス（デフォルト: 'rl:'） */
  keyPrefix?: string
}
```

### 完全な設定例

```ts
import { createRateLimitMiddleware, MemoryRateLimitStore } from '@guren/core'

const store = new MemoryRateLimitStore()

const rateLimiter = createRateLimitMiddleware({
  limit: 100,
  windowMs: 60 * 1000,          // 1分
  store,
  keyPrefix: 'api:',
  headers: true,
  message: 'レート制限を超過しました。しばらくしてからお試しください。',
  statusCode: 429,

  // 認証済みユーザーまたはIPに基づくキー
  keyGenerator: async (ctx) => {
    const user = ctx.get('user')
    if (user?.id) {
      return `user:${user.id}`
    }
    return ctx.req.header('x-forwarded-for')?.split(',')[0] ?? 'unknown'
  },

  // 管理者ユーザーはスキップ
  skip: async (ctx) => {
    const user = ctx.get('user')
    return user?.role === 'admin'
  },

  // カスタムレスポンス
  onRateLimited: (ctx, retryAfter) => {
    return ctx.json({
      error: 'リクエスト数が多すぎます',
      retryAfter,
      documentation: 'https://api.example.com/docs/rate-limits',
    }, 429)
  },
})
```

## レート制限ヘッダー

`headers: true`（デフォルト）の場合、以下のヘッダーがすべてのレスポンスに追加されます：

| ヘッダー | 説明 |
|----------|------|
| `X-RateLimit-Limit` | ウィンドウ内で許可される最大リクエスト数 |
| `X-RateLimit-Remaining` | 現在のウィンドウでの残りリクエスト数 |
| `X-RateLimit-Reset` | ウィンドウがリセットされるUnixタイムスタンプ |
| `Retry-After` | リトライまでの秒数（制限時のみ） |

### レスポンスヘッダーの例

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1705312800
```

## ストレージバックエンド

### メモリストア

シングルプロセスアプリケーションに適しています：

```ts
import { MemoryRateLimitStore } from '@guren/core'

const store = new MemoryRateLimitStore(60000) // 60秒ごとにクリーンアップ

const rateLimiter = createRateLimitMiddleware({
  limit: 100,
  store,
})

// シャットダウン時にクリーンアップ
process.on('SIGTERM', () => {
  store.destroy()
})
```

### スライディングウィンドウストア

トラフィックを滑らかにするより正確なレート制限：

```ts
import { SlidingWindowRateLimitStore } from '@guren/core'

const store = new SlidingWindowRateLimitStore()

const rateLimiter = createRateLimitMiddleware({
  limit: 100,
  windowMs: 60 * 1000,
  store,
})
```

**固定ウィンドウ vs スライディングウィンドウ：**
- **固定ウィンドウ**: ウィンドウ境界でカウンターをリセット。境界付近でバーストを許可。
- **スライディングウィンドウ**: 各リクエストのタイムスタンプを追跡。より滑らかなレート制限を提供。

### Redisストア（カスタム実装）

分散アプリケーション用のRedisバックエンドストアを実装：

```ts
import type { RateLimitStore, RateLimitEntry } from '@guren/core'

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private redis: Redis) {}

  async get(key: string): Promise<RateLimitEntry | null> {
    const data = await this.redis.hgetall(key)
    if (!data.count) return null

    return {
      count: parseInt(data.count, 10),
      resetAt: parseInt(data.resetAt, 10),
    }
  }

  async increment(key: string, windowMs: number): Promise<RateLimitEntry> {
    const now = Date.now()
    const resetAt = now + windowMs

    const [count] = await this.redis
      .multi()
      .hincrby(key, 'count', 1)
      .hsetnx(key, 'resetAt', resetAt.toString())
      .pexpire(key, windowMs)
      .exec()

    const entry = await this.get(key)
    return entry ?? { count: 1, resetAt }
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(key)
  }
}
```

## ヘルパー関数

### レート制限情報の取得

インクリメントせずにレート制限状態を確認：

```ts
import { getRateLimitInfo, MemoryRateLimitStore } from '@guren/core'

const store = new MemoryRateLimitStore()

// ユーザーのレート制限状態を確認
const info = await getRateLimitInfo('user:123', store, { limit: 100 })

console.log(`残り${info.remaining}リクエスト`)
console.log(`${info.resetAt}にリセット`)
console.log(`制限中: ${info.isLimited}`)
```

### レート制限のリセット

特定のキーのレート制限をクリア：

```ts
import { resetRateLimit, MemoryRateLimitStore } from '@guren/core'

const store = new MemoryRateLimitStore()

// キャプチャ検証成功後にリセット
await resetRateLimit('user:123', store)

// カスタムキープレフィックス付き
await resetRateLimit('192.168.1.1', store, { keyPrefix: 'login:' })
```

## 一般的なパターン

### エンドポイントごとに異なる制限

```ts
import { Router } from '@guren/core'

// 認証に厳しい制限
const authLimiter = createRateLimitMiddleware({
  limit: 5,
  windowMs: 15 * 60 * 1000, // 15分
  keyPrefix: 'auth:',
})

// 標準API制限
const apiLimiter = createRateLimitMiddleware({
  limit: 100,
  windowMs: 60 * 1000, // 1分
  keyPrefix: 'api:',
})

// 検索にはより厳しい制限（負荷の高い操作のため）
const searchLimiter = createRateLimitMiddleware({
  limit: 20,
  windowMs: 60 * 1000,
  keyPrefix: 'search:',
})

// ルートに適用
const router = new Router()

router.post('/login', [AuthController, 'login']).middleware(authLimiter)
router.post('/register', [AuthController, 'register']).middleware(authLimiter)
router.get('/api/*', [ApiController, 'handle']).middleware(apiLimiter)
router.get('/search', [SearchController, 'search']).middleware(searchLimiter)
```

### ユーザーベースのレート制限

```ts
const userRateLimiter = createRateLimitMiddleware({
  limit: 1000,
  windowMs: 60 * 60 * 1000, // 1時間

  keyGenerator: async (ctx) => {
    const user = ctx.get('user')
    if (!user) {
      // 未認証リクエストはIPにフォールバック
      return `ip:${ctx.req.header('x-forwarded-for') ?? 'unknown'}`
    }

    // プランごとに異なる制限
    const limitMultiplier = user.plan === 'premium' ? 10 : 1
    return `user:${user.id}:${limitMultiplier}`
  },
})
```

### 信頼されたソースをスキップ

```ts
const rateLimiter = createRateLimitMiddleware({
  limit: 100,
  skip: (ctx) => {
    // 内部サービスはスキップ
    const apiKey = ctx.req.header('x-api-key')
    return apiKey === process.env.INTERNAL_API_KEY

    // または特定のIPをスキップ
    const ip = ctx.req.header('x-forwarded-for')
    return ['10.0.0.1', '10.0.0.2'].includes(ip ?? '')
  },
})
```

### カスタムエラーレスポンス

```ts
const rateLimiter = createRateLimitMiddleware({
  limit: 100,
  onRateLimited: (ctx, retryAfter) => {
    // レート制限ヒットをログ
    console.warn(`レート制限ヒット: ${ctx.req.path}`)

    // カスタムレスポンスを返す
    return ctx.json({
      status: 'error',
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'レート制限を超過しました。',
      retryAfter,
      upgrade: 'https://example.com/pricing',
    }, 429)
  },
})
```

## テスト

```ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import {
  createRateLimitMiddleware,
  MemoryRateLimitStore,
  getRateLimitInfo,
  resetRateLimit,
} from '@guren/core'

describe('レート制限', () => {
  let store: MemoryRateLimitStore
  let app: Hono

  beforeEach(() => {
    store = new MemoryRateLimitStore(0) // 自動クリーンアップを無効化
    app = new Hono()
  })

  afterEach(() => {
    store.destroy()
  })

  test('制限内のリクエストを許可する', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 5, store }))
    app.get('/', (c) => c.text('OK'))

    for (let i = 0; i < 5; i++) {
      const res = await app.request('/')
      expect(res.status).toBe(200)
    }
  })

  test('制限超過のリクエストをブロックする', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 3, store }))
    app.get('/', (c) => c.text('OK'))

    // 制限を使い切る
    for (let i = 0; i < 3; i++) {
      await app.request('/')
    }

    // 次のリクエストはブロックされるべき
    const res = await app.request('/')
    expect(res.status).toBe(429)
  })

  test('レート制限ヘッダーを返す', async () => {
    app.use('*', createRateLimitMiddleware({ limit: 10, store }))
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/')

    expect(res.headers.get('X-RateLimit-Limit')).toBe('10')
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('9')
    expect(res.headers.get('X-RateLimit-Reset')).toBeDefined()
  })

  test('カスタムキージェネレーターを使用する', async () => {
    app.use(
      '*',
      createRateLimitMiddleware({
        limit: 1,
        store,
        keyGenerator: (ctx) => ctx.req.header('X-API-Key') ?? 'anonymous',
      })
    )
    app.get('/', (c) => c.text('OK'))

    // 最初のユーザーは制限に達する
    await app.request('/', { headers: { 'X-API-Key': 'user1' } })
    const res1 = await app.request('/', { headers: { 'X-API-Key': 'user1' } })
    expect(res1.status).toBe(429)

    // 2番目のユーザーはまだリクエストできる
    const res2 = await app.request('/', { headers: { 'X-API-Key': 'user2' } })
    expect(res2.status).toBe(200)
  })

  test('ウィンドウ期限切れ後に制限をリセットする', async () => {
    app.use(
      '*',
      createRateLimitMiddleware({
        limit: 1,
        windowMs: 100, // 100msウィンドウ
        store,
      })
    )
    app.get('/', (c) => c.text('OK'))

    await app.request('/')
    let res = await app.request('/')
    expect(res.status).toBe(429)

    // ウィンドウが期限切れになるのを待つ
    await new Promise((r) => setTimeout(r, 150))

    res = await app.request('/')
    expect(res.status).toBe(200)
  })
})
```

## ベストプラクティス

1. **適切なウィンドウを使用**: 一般APIには短いウィンドウ（1分）、認証にはより長いウィンドウ（15〜60分）。

2. **エンドポイントごとに異なる制限**: 高コストまたは機密性の高い操作にはより厳しい制限を適用。

3. **可能な場合はユーザーでキー設定**: 認証済みユーザーキーにより、1人のユーザーが他のユーザーに影響を与えることを防止。

4. **常にヘッダーを含める**: クライアントが適切なバックオフ戦略を実装できるように。

5. **本番環境ではRedisを使用**: メモリストアは複数サーバーインスタンスでは機能しない。

6. **レート制限ヒットをログ**: 乱用パターンを監視し、それに応じて制限を調整。

7. **アップグレードパスを提供**: ユーザーにより高い制限を得る方法を知らせる（例：プレミアムプラン）。

8. **ストアをクリーンアップ**: シャットダウン時にメモリストアで`destroy()`を呼び出す。

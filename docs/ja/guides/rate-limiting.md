# レート制限ガイド

レート制限は、アプリケーションを乱用から守るための仕組みです。Guren のレート制限は柔軟に設定でき、保存先のストレージを選べるほか、制限のキーを作る関数を差し替えたり、固定ウィンドウとスライディングウィンドウのどちらのアルゴリズムを使うかを選んだりできます。

## コアコンセプト

- **RateLimitStore**: レート制限のデータを保存するためのインターフェース。
- **MemoryRateLimitStore**: 単一プロセスで動くアプリケーション向けの、メモリ上のストア。
- **SlidingWindowRateLimitStore**: スライディングウィンドウ方式の実装。固定ウィンドウより正確に制限できる。
- **レート制限ヘッダー**: 制限の状況をクライアントに伝える標準的なヘッダー。

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

  /** 制限時のHTTPステータスコード（デフォルト: 429）。`@guren/core` から再エクスポートされている `ContentfulStatusCode` 型です */
  statusCode?: ContentfulStatusCode

  /** レート制限キーのプレフィックス（デフォルト: 'rl:'） */
  keyPrefix?: string

  /** プロキシヘッダー (CF-Connecting-IP, True-Client-IP, X-Real-IP, X-Forwarded-For) からクライアントIPを解決（デフォルト: false） */
  trustProxy?: boolean
}
```

### プロキシ配下でのデプロイ

アプリが常にリバースプロキシや CDN(Cloudflare、ALB、Nginx)の背後にあるなら、`trustProxy` を有効にするだけでクライアントごとに制限をかけられます。独自の `keyGenerator` を書く必要はありません。

```ts
createRateLimitMiddleware({
  limit: 100,
  trustProxy: true, // CF-Connecting-IP → True-Client-IP → X-Real-IP → X-Forwarded-For[0] の順で解決
})
```

> **警告:** `trustProxy` は、すべてのリクエストが必ずプロキシを通る場合にだけ有効にしてください。アプリを直接公開している環境では、クライアントがこれらのヘッダーを偽装して、クライアントごとの制限をすり抜けられてしまいます。デフォルトが `false` になっているのはこのためです。

### 完全な設定例

```ts
import { AUTH_CONTEXT_KEY, createRateLimitMiddleware, MemoryRateLimitStore } from '@guren/core'
import type { AuthContext } from '@guren/core'
import type { Context } from 'hono'

interface AppUser {
  id: number
  role: string
}

const currentUser = async (ctx: Context) => {
  const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
  return (await auth?.user<AppUser>()) ?? null
}

const store = new MemoryRateLimitStore()

const rateLimiter = createRateLimitMiddleware({
  limit: 100,
  windowMs: 60 * 1000,          // 1分
  store,
  keyPrefix: 'api:',
  headers: true,
  message: 'レート制限を超過しました。しばらくしてからお試しください。',
  statusCode: 429,

  // ログイン中のユーザー、いなければクライアントIPに基づくキー
  keyGenerator: async (ctx) => {
    const user = await currentUser(ctx)
    if (user) {
      return `user:${user.id}`
    }
    return ctx.req.header('x-forwarded-for')?.split(',')[0] ?? 'unknown'
  },

  // 管理者ユーザーはスキップ
  skip: async (ctx) => {
    const user = await currentUser(ctx)
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

`headers: true`（デフォルト）のときは、すべてのレスポンスに次のヘッダーが付きます。

| ヘッダー | 説明 |
|----------|------|
| `X-RateLimit-Limit` | 1 つのウィンドウで許可されるリクエスト数の上限 |
| `X-RateLimit-Remaining` | 現在のウィンドウで送れる残りのリクエスト数 |
| `X-RateLimit-Reset` | ウィンドウがリセットされる時刻（Unix タイムスタンプ） |
| `Retry-After` | 再試行できるまでの秒数（制限にかかったときだけ） |

### レスポンスヘッダーの例

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1705312800
```

## ストレージバックエンド

### メモリストア

単一プロセスで動くアプリケーションに向いています。

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

固定ウィンドウより正確で、なめらかに制限をかけられます。

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
- **固定ウィンドウ**: ウィンドウの区切りでカウンターをリセットする。区切りの前後ではリクエストが集中しても通ってしまう。
- **スライディングウィンドウ**: リクエストごとのタイムスタンプを記録する。制限のかかり方がなめらかになる。

### Redisストア（分散環境）

複数のサーバーで動かすアプリケーションでは、フレームワークに含まれている Redis ベースのストアを使います。

```ts
import { createRateLimitMiddleware } from '@guren/core'
import { createRedisClient, RedisRateLimitStore, RedisSlidingWindowRateLimitStore } from '@guren/core/redis'

const redis = createRedisClient({ url: process.env.REDIS_URL })

const limiter = createRateLimitMiddleware({
  max: 60,
  windowMs: 60_000,
  store: new RedisRateLimitStore(redis),
})

// Sliding-window variant for smoother limiting
const sliding = createRateLimitMiddleware({
  max: 60,
  windowMs: 60_000,
  store: new RedisSlidingWindowRateLimitStore(redis),
})
```

> [!NOTE]
> 独自の動作が必要なら、`@guren/core` の `RateLimitStore` インターフェース（`get` / `increment` / `reset`）を実装すれば、どんなストアでも使えます。

## ヘルパー関数

### レート制限情報の取得

カウントを増やさずに、レート制限の状態だけを確認できます。

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

特定のキーについて、レート制限のカウントを消去できます。

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

Bearer トークンで認証するルートでは、`getApiToken(ctx)` が返すトークンの ID をキーにします。1 人のユーザーが持つ複数のトークンで上限を共有したい場合は、`result.userId` をキーにしてください。セッションで認証するルートでは、上の完全な設定例の `currentUser()` のように、認証コンテキストからユーザーを取り出します。

```ts
import { createBearerTokenMiddleware, createRateLimitMiddleware, getApiToken } from '@guren/core'

const tokenRateLimiter = createRateLimitMiddleware({
  limit: 1000,
  windowMs: 60 * 60 * 1000, // 1時間
  keyPrefix: 'token:',

  // getApiToken() はBearerトークンミドルウェアの実行前は null を返すため、
  // その前にマウントするとすべての呼び出し元が同じバケットに入ります。
  keyGenerator: (ctx) => {
    const result = getApiToken(ctx)
    if (!result) {
      throw new Error('tokenRateLimiter must run after createBearerTokenMiddleware')
    }
    return result.token.id
  },
})

app.use('/api/*', createBearerTokenMiddleware({ store: tokenStore }))
app.use('/api/*', tokenRateLimiter)
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

1. **ウィンドウの長さを用途に合わせる**: 一般的な API には短いウィンドウ（1 分）を、認証には長めのウィンドウ（15〜60 分）を使う。

2. **エンドポイントごとに制限を変える**: 負荷の高い操作や機密性の高い操作には、厳しめの制限をかける。

3. **できるだけユーザーをキーにする**: 認証済みのユーザーをキーにすれば、あるユーザーのリクエストが他のユーザーの制限に影響しない。

4. **ヘッダーは常に返す**: クライアントが適切なバックオフを実装できるようにする。

5. **本番環境では Redis を使う**: メモリストアは、サーバーのインスタンスが複数あると正しく機能しない。

6. **制限にかかったリクエストをログに残す**: 乱用のパターンを監視し、必要に応じて制限を調整する。

7. **上限を引き上げる方法を案内する**: より高い上限を得る方法（プレミアムプランなど）をユーザーに伝える。

8. **ストアを後片付けする**: シャットダウン時に、メモリストアの `destroy()` を呼ぶ。

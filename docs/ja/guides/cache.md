# キャッシュガイド

Guren は複数のストレージバックエンドをサポートする統一されたキャッシュAPIを提供します。キャッシュは、コストの高い計算やデータベースクエリを保存して高速に取得することで、アプリケーションのパフォーマンス向上に役立ちます。

推奨パターン: `@guren/core` から cache API をインポートし、provider で cache manager を構成します。各サービスではキャッシュキーの管理と無効化を担当します。

## コアコンセプト

- **CacheStore** – キャッシュ操作（get、set、deleteなど）のインターフェース。すべてのドライバがこのインターフェースを実装。
- **CacheManager** – 複数のキャッシュストアを設定・アクセスするための中央レジストリ。
- **TaggedCache** – タグでキャッシュアイテムをグループ化し、一括無効化を可能にする。
- **Drivers** – ストレージバックエンド：Memory（デフォルト）、Redis、File。

## 基本的な使い方

### クイックスタート（コンテナバインディングファサード）

最もシンプルにキャッシュを使う方法は、アプリケーションコンテナからファサードを作ることです:

```ts
import { createFacades } from '@guren/core'

const { Cache } = createFacades(app.container)

// 値を保存（TTLは秒単位）
await Cache.store().set('user:1', { name: 'John' }, 3600)

// 値を取得
const user = await Cache.store().get<{ name: string }>('user:1')

// キーが存在するか確認
const exists = await Cache.store().has('user:1')

// 値を削除
await Cache.store().delete('user:1')
```

### 直接インスタンス化

`CacheManager` を直接作成することもできます:

```ts
import { CacheManager } from '@guren/core'

const cache = new CacheManager()

await cache.store().set('user:1', { name: 'John' }, 3600)
const user = await cache.store().get<{ name: string }>('user:1')
```

### キャッシュ操作

```ts
const store = cache.store()

// 基本操作
await store.set('key', 'value', 3600)  // 3600秒のTTLで設定
await store.set('key', 'value')         // 有効期限なしで設定
const value = await store.get<string>('key')
const exists = await store.has('key')
await store.delete('key')
await store.clear()                     // 全アイテムをクリア

// インクリメント/デクリメント
await store.set('counter', 0)
await store.increment('counter')        // 1
await store.increment('counter', 5)     // 6
await store.decrement('counter', 2)     // 4

// 残りTTLを取得（秒単位）
const ttl = await store.ttl('key')      // -1 = 有効期限なし, -2 = 見つからない

// バッチ操作
await store.setMany(new Map([
  ['key1', 'value1'],
  ['key2', 'value2'],
]), 3600)

const values = await store.getMany<string>(['key1', 'key2'])
const deleted = await store.deleteMany(['key1', 'key2'])
```

### Rememberパターン

`remember`メソッドはデータベースクエリやコストの高い計算をキャッシュするのに最適です：

```ts
// 1時間キャッシュ、キャッシュがなければ計算
const posts = await cache.store().remember('posts:recent', 3600, async () => {
  return await Post.orderBy('createdAt', 'desc').limit(10).get()
})

// 手動でクリアするまで永久にキャッシュ
const settings = await cache.store().rememberForever('app:settings', async () => {
  return await Settings.all()
})
```

## 設定

### 複数のストア

アプリケーションで複数のキャッシュバックエンドを設定：

```ts
import { CacheManager } from '@guren/core'
import { createRedisClient } from '@guren/core'

const redis = createRedisClient({ url: process.env.REDIS_URL })

const cache = new CacheManager({
  default: 'redis',
  stores: {
    memory: {
      driver: 'memory',
      maxSize: 1000,       // 最大アイテム数（デフォルト: Infinity）
      checkPeriod: 60000,  // クリーンアップ間隔（ms）（デフォルト: 60000）
    },
    redis: {
      driver: 'redis',
      client: redis,
      prefix: 'myapp:cache:', // キープレフィックス（デフォルト: 'cache:'）
    },
    file: {
      driver: 'file',
      path: './storage/cache',
      extension: '.cache',    // ファイル拡張子（デフォルト: '.cache'）
    },
  },
})

// デフォルトストア（redis）を使用
await cache.store().set('key', 'value')

// 特定のストアを使用
await cache.store('memory').set('temp', 'data', 60)
await cache.store('file').set('persistent', 'data')
```

### ドライバオプション

**Memory Store:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `maxSize` | `Infinity` | 最大アイテム数 |
| `checkPeriod` | `60000` | 期限切れアイテムのクリーンアップ間隔（ms） |

**Redis Store:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `client` | 必須 | Redisクライアントインスタンス |
| `prefix` | `'cache:'` | 全キャッシュキーのプレフィックス |

**File Store:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `path` | 必須 | キャッシュファイルのディレクトリパス |
| `extension` | `'.cache'` | キャッシュファイルの拡張子 |

## タグ付きキャッシュ

タグを使用すると、関連するキャッシュアイテムをグループ化して簡単に無効化できます：

```ts
const cache = new CacheManager()

// タグ付きでアイテムを保存
await cache.store().tags(['posts', 'user:1']).set('user:1:posts', posts, 3600)
await cache.store().tags(['posts', 'user:2']).set('user:2:posts', posts, 3600)
await cache.store().tags(['comments', 'user:1']).set('user:1:comments', comments)

// タグ付きアイテムを取得
const userPosts = await cache.store().tags(['posts', 'user:1']).get('user:1:posts')

// 特定のタグを持つ全アイテムをフラッシュ
await cache.store().tags(['user:1']).flush()  // user:1:postsとuser:1:commentsを削除

// 全投稿をフラッシュ
await cache.store().tags(['posts']).flush()   // 全投稿キャッシュを削除
```

### 一般的なタグパターン

```ts
// モデルベースのキャッシュ
await cache.store().tags([`posts`, `post:${post.id}`]).set(`post:${post.id}`, post)

// 更新時に無効化
await post.save()
await cache.store().tags([`post:${post.id}`]).flush()

// 全投稿を無効化
await cache.store().tags(['posts']).flush()

// ユーザー固有のキャッシュ
await cache.store().tags([`user:${userId}`, 'dashboard']).set(
  `user:${userId}:dashboard`,
  dashboardData,
  300
)

// ログアウト時に全ユーザーデータをクリア
await cache.store().tags([`user:${userId}`]).flush()
```

## ユースケース

### データベースクエリのキャッシュ

```ts
import { CacheManager } from '@guren/core'
import { Post } from '@/app/Models/Post'

const cache = new CacheManager()

export async function getRecentPosts(): Promise<Post[]> {
  return cache.store().remember('posts:recent', 300, async () => {
    return await Post.orderBy('createdAt', 'desc').limit(10).get()
  })
}

export async function getPost(id: number): Promise<Post | null> {
  return cache.store().tags(['posts', `post:${id}`]).remember(
    `post:${id}`,
    3600,
    async () => Post.find(id)
  )
}

// 投稿更新時に無効化
export async function updatePost(id: number, data: Partial<Post>): Promise<void> {
  await Post.where('id', id).update(data)
  await cache.store().tags([`post:${id}`]).flush()
}
```

### レート制限データ

```ts
const cache = new CacheManager()

export async function checkRateLimit(ip: string, limit: number): Promise<boolean> {
  const key = `ratelimit:${ip}`
  const current = await cache.store().get<number>(key) ?? 0

  if (current >= limit) {
    return false
  }

  await cache.store().increment(key)

  // 最初のリクエスト時のみTTLを設定
  if (current === 0) {
    await cache.store().set(key, 1, 60) // 1分間のウィンドウ
  }

  return true
}
```

### セッションライクなデータ

```ts
const cache = new CacheManager({
  default: 'redis',
  stores: {
    redis: { driver: 'redis', client: redis },
  },
})

export async function setUserPreferences(
  userId: string,
  preferences: Record<string, unknown>
): Promise<void> {
  await cache.store().set(`user:${userId}:prefs`, preferences, 86400) // 24時間
}

export async function getUserPreferences(
  userId: string
): Promise<Record<string, unknown> | null> {
  return cache.store().get(`user:${userId}:prefs`)
}
```

## テスト

テストにはMemoryストアを使用：

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { CacheManager } from '@guren/core'

describe('Cache', () => {
  let cache: CacheManager

  beforeEach(async () => {
    cache = new CacheManager()
    await cache.store().clear()
  })

  test('値を保存して取得する', async () => {
    await cache.store().set('key', 'value', 3600)
    const value = await cache.store().get<string>('key')
    expect(value).toBe('value')
  })

  test('rememberがコールバック結果をキャッシュする', async () => {
    let callCount = 0

    const getValue = () => cache.store().remember('computed', 3600, async () => {
      callCount++
      return 'computed-value'
    })

    await getValue()
    await getValue()

    expect(callCount).toBe(1) // コールバックは1回だけ呼ばれる
  })

  test('タグ付きキャッシュが正しくフラッシュされる', async () => {
    await cache.store().tags(['posts']).set('post:1', 'data1')
    await cache.store().tags(['posts']).set('post:2', 'data2')
    await cache.store().tags(['users']).set('user:1', 'data3')

    await cache.store().tags(['posts']).flush()

    expect(await cache.store().tags(['posts']).get('post:1')).toBeNull()
    expect(await cache.store().tags(['posts']).get('post:2')).toBeNull()
    expect(await cache.store().tags(['users']).get('user:1')).toBe('data3')
  })
})
```

## ベストプラクティス

1. **適切なTTLを使用**: データの変動性に基づいて適切な有効期限を設定。

2. **関連データにタグを使用**: エンティティや機能でキャッシュアイテムをグループ化して簡単に無効化。

3. **適切なレベルでキャッシュ**: コントローラーのレスポンスではなく、データベース結果をキャッシュ。

4. **キャッシュミスを適切に処理**: キャッシュミス時のフォールバックロジックを常に提供。

5. **型付きジェネリクスを使用**: 型安全性のため、値取得時に型を指定。

6. **キャッシュヒット率を監視**: TTLと戦略を最適化するためにキャッシュの効果を追跡。

7. **本番環境ではRedisを使用**: Memoryキャッシュは再起動で消えるため、本番ではRedisを使用。

8. **機密データのキャッシュを避ける**: パスワード、トークン、その他の機密情報はキャッシュしない。

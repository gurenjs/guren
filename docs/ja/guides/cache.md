# キャッシュガイド

Guren のキャッシュ API は共通で、裏側のストレージバックエンドだけを差し替えられます。コストの高い計算やデータベースクエリの結果を保存しておき、次からは素早く取り出すことで、アプリケーションを速く保てます。

推奨パターン: `@guren/core` から cache API をインポートし、provider で cache manager を構成します。各サービスではキャッシュキーの管理と無効化を担当します。

## コアコンセプト

- **CacheStore**: キャッシュ操作（get、set、delete など）のインターフェース。すべてのドライバがこれを実装。
- **CacheManager**: 複数のキャッシュストアを設定・アクセスするための中央レジストリ。
- **TaggedCache**: キャッシュアイテムをタグでまとめ、一括で無効化するための仕組み。
- **Drivers**: ストレージバックエンド：Memory（デフォルト）、Redis、File。

## 基本的な使い方

### クイックスタート（コンテナバインディングファサード）

いちばん手軽なのは、アプリケーションコンテナからファサードを作る方法です。

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

`CacheManager` を直接作成することもできます。

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

`remember` メソッドは、データベースクエリやコストの高い計算をキャッシュするのに向いています。

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

アプリケーションで複数のキャッシュバックエンドを設定できます。

```ts
import { CacheManager } from '@guren/core'
import { createRedisClient } from '@guren/core'

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
      // `client` には関数も渡せます。最初にこのストアが使われたときに実行されるため、
      // 宣言だけして選ばれなかったストアは接続を開きません。
      client: () => createRedisClient({ url: process.env.REDIS_URL }),
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
| `now` | `Date.now` | TTL 計算に使う時計（エポック ms）。テストで注入可能 |

**Redis Store:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `client` | 必須 | ioredis クライアント、または同期的にそれを返す関数（ストアが最初に使われたときに実行されます） |
| `prefix` | `'cache:'` | 全キャッシュキーのプレフィックス |

**File Store:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `path` | 必須 | キャッシュファイルのディレクトリパス |
| `extension` | `'.cache'` | キャッシュファイルの拡張子 |
| `now` | `Date.now` | TTL 計算に使う時計（エポック ms）。テストで注入可能 |

## タグ付きキャッシュ

タグを付けておくと、関連するキャッシュアイテムをまとめて無効化できます。

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
    redis: { driver: 'redis', client: () => createRedisClient({ url: process.env.REDIS_URL }) },
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

テストでは Memory ストアを使います。

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

1. **TTL は中身に合わせる**: データがどれくらいの頻度で変わるかを見て有効期限を決めます。

2. **関連データにはタグを付ける**: エンティティや機能単位でまとめておけば、無効化が一度で済みます。

3. **キャッシュする層を選ぶ**: コントローラーのレスポンスではなく、データベースの結果をキャッシュします。

4. **キャッシュミスに備える**: 見つからなかったときのフォールバックを必ず用意します。

5. **ジェネリクスで型を指定する**: 値を取り出すときに型を書いておくと、型安全に扱えます。

6. **ヒット率を監視する**: 効き具合を追いながら TTL と戦略を調整します。

7. **本番では Redis を使う**: Memory キャッシュは再起動で消えます。

8. **機密データはキャッシュしない**: パスワードやトークンなどは対象から外します。

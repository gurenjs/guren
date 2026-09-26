# キャッシュガイド

Guren のキャッシュは 1 つの API で扱い、裏側のストレージだけを差し替えられます。重い計算やデータベースクエリの結果を保存しておき、次からはすぐに取り出せるようにして、アプリケーションを速く保ちます。

標準的な使い方は次のとおりです。キャッシュの API は `@guren/core` から import し、ストアは `config/cache.ts` で設定します。キャッシュキーの管理と無効化は、それぞれのサービスが受け持ちます。

## コアコンセプト

- **CacheStore**: キャッシュ操作（get、set、delete など）のインターフェース。すべてのドライバがこれを実装します
- **CacheManager**: 複数のキャッシュストアを設定し、取り出すための中心のレジストリ
- **TaggedCache**: キャッシュのアイテムをタグでまとめ、一度に無効化するための仕組み
- **Drivers**: ストレージの実装。Memory（デフォルト）、Redis、File があります

## 基本的な使い方

### クイックスタート（コンテナバインディングファサード）

いちばん手軽なのは、アプリケーションのコンテナからファサードを作る方法です。

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

`CacheManager` を自分で作ることもできます。

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

データベースクエリや重い計算の結果をキャッシュするには、`remember` メソッドが便利です。

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

### 同時ミス

同じプロセスの中で、同じキー・同じ TTL の呼び出しが同時にキャッシュミスした場合、コールバックは 1 回だけ実行され、その呼び出し元は全員が同じ結果を受け取ります。成功すれば同じオブジェクトを、失敗すれば同じ例外を受け取ります。例外を投げたコールバックは何もキャッシュしないので、次の呼び出しでもう一度実行されます。ヒットは共有されず、同時にヒットした呼び出しはそれぞれ `get()` が返す値を受け取ります。

この動きをするのは `remember` と `rememberForever` で、`cache.store()` で取り出したストアでも、タグ付きキャッシュでも同じです。`registerStore()` で追加したストアや、`new TaggedCache(store, tags)` で作ったタグ付きキャッシュも含まれます。コールバックを共有するのは、同じストアインスタンスを通した呼び出しだけです。`CacheManager` が 2 つある場合や、同じ Redis を指すストア名が 2 つある場合は、それぞれがコールバックを実行します。`new MemoryStore()` や `new FileStore(...)` のように自分で作って直接呼ぶストアは、コールバックを共有しません。

共有されるのは同じプロセスの中だけです（Cloudflare Workers では同じ isolate の中）。別々のサーバーが同時に同じキーでミスすれば、それぞれがコールバックを実行します。

- 一緒にミスした呼び出し元は同じオブジェクトを受け取るので、結果は読み取り専用として扱ってください。1 つの呼び出し元が加えた変更は、ほかの呼び出し元からも見えます。変更したいときは、先に `structuredClone(posts)` のようにコピーしてください。メモリストアはヒットのときも保存したオブジェクトそのものを返すので、変更するとキャッシュ内の値まで変わります。
- コールバックは相乗りしたすべての呼び出し元のために実行されるので、コールバックを始めたリクエストに依存させないでください。そのリクエストの `AbortSignal` は渡さず、ログイン中のユーザーやロケールといったリクエストの状態も、キーに含めていない限り読まないでください。最初の呼び出し元のリクエストが原因の失敗（中断など）は、相乗りした全員に届きます。
- TTL が違う呼び出しはコールバックを共有しません。`rememberForever` も、それだけで 1 つの TTL として扱われます。各コールバックは自分の呼び出し元が指定した TTL で結果を保存し、最後に終わったものがほかを上書きします。たとえば `rememberForever` の後に `remember(key, 60, ...)` が終わると、エントリは 60 秒で期限切れになります。
- 実行中のコールバックが始まってから 10 秒以上たって届いた呼び出しは、待たずに自分のコールバックを実行します。すでに待っている呼び出し元は、最初のコールバックを待ち続けます。コールバックの中の遅い I/O には、それぞれタイムアウトを設定してください。
- 同じストアインスタンスを通してそのキーに書き込むと（`set`、`delete`、`setMany`、`deleteMany`、`clear`、タグ付きキャッシュの `set` と `delete`）、その後のミスは書き込み前に始まったコールバックに相乗りせず、新しくコールバックを実行します。実行中のコールバックは取り消されず、終わった時点で結果を保存するので、書き込んだ値が上書きされることがあります。

## 設定

`bunx guren add cache` を実行すると、`config/cache.ts` が書き出され、`config/env.ts` に `CACHE_STORE` が宣言され、定義が `createApp({ config })` に追加されます。

```ts
// config/cache.ts
import { defineCacheConfig } from '@guren/core'

// CACHE_STORE でストアを選ぶ。`memory` はプロセス単位なので、長時間動く
// 1 台のサーバーでは正しく動くが、Workers、Lambda、Vercel では 2 つの
// リクエストが別インスタンスに届くことがあり、正しく動かない。
export default defineCacheConfig((env) => ({
  default: env.CACHE_STORE,
  stores: {
    memory: { driver: 'memory' },
    // Redis を使う場合は '@guren/core/redis' の `createRedisClient` と
    // `redis: { driver: 'redis', client: () => createRedisClient({ url: env.REDIS_URL }) }`
    // のエントリを追加し、REDIS_URL を config/env.ts に宣言する。このモジュールは
    // ioredis を読み込むので、使う場所でだけインポートする。関数はストアを最初に
    // 解決したときに実行されるため、CACHE_STORE で選ぶまで接続は開かない。
  },
}))
```

```ts
// src/app.ts
import cache from '../config/cache.js'

const app = createApp({
  env,
  config: [database, http, cache],
  routes: registerWebRoutes,
})
```

コールバックには検証済みの環境変数が渡されるので、読み取るキーはすべて `config/env.ts` に宣言しておきます。変数の宣言のしかたと、定義が起動時にどう処理されるかは[設定ガイド](./configuration.md)にあります。

### 複数のストア

アプリで使うかもしれないバックエンドはすべて `stores` に宣言しておき、デフォルトを `CACHE_STORE` で選びます。

```ts
// config/cache.ts
import { defineCacheConfig } from '@guren/core'
import { createRedisClient } from '@guren/core/redis'

export default defineCacheConfig((env) => ({
  default: env.CACHE_STORE,
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
      client: () => createRedisClient({ url: env.REDIS_URL }),
      prefix: 'myapp:cache:', // キープレフィックス（デフォルト: 'cache:'）
    },
    file: {
      driver: 'file',
      path: './storage/cache',
      extension: '.cache',    // ファイル拡張子（デフォルト: '.cache'）
    },
  },
}))
```

`CACHE_STORE` の名前は起動時には検査されません。`stores` にない名前を指定すると、そのストアを最初に解決したときに `Cache store not found` の例外が投げられます。

この定義によって、マネージャーがコンテナの `cache` にバインドされます。

```ts
const cache = app.container.make('cache') // CacheManager

// デフォルトストア（CACHE_STORE）を使用
await cache.store().set('key', 'value')

// 特定のストアを使用
await cache.store('memory').set('temp', 'data', 60)
await cache.store('file').set('persistent', 'data')
```

キャッシュをサービスプロバイダで設定しているアプリも、そのまま動きます。詳しくは[サービスプロバイダを使うアプリ](./configuration.md#サービスプロバイダを使うアプリ)を参照してください。

### ドライバオプション

**Memory Store:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `maxSize` | `Infinity` | 最大アイテム数 |
| `checkPeriod` | `60000` | 期限切れアイテムのクリーンアップ間隔（ms） |
| `now` | `Date.now` | TTL の計算に使う時計（エポック ms）。テストで差し替えられます |

**Redis Store:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `client` | 必須 | ioredis のクライアント、またはそれを同期的に返す関数（関数はストアが最初に使われたときに実行されます） |
| `prefix` | `'cache:'` | すべてのキャッシュキーに付けるプレフィックス |

**File Store:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `path` | 必須 | キャッシュファイルを置くディレクトリのパス |
| `extension` | `'.cache'` | キャッシュファイルの拡張子 |
| `now` | `Date.now` | TTL の計算に使う時計（エポック ms）。テストで差し替えられます |

期限切れのアイテムを `get()`、`has()`、`ttl()` で読むと、キーは存在しないものとして扱われますが、ファイルはディスクに残ります。読んだ後で、別の書き込みがファイルを置き換えているかもしれないからです。期限切れのファイルを削除するのは `cleanup()` です。`cleanup()` は `add()`、`increment()`、`decrement()`、`delete()` と同じキー単位のロックを取ってから、期限切れのファイルを別の場所に移し、そこでもう一度確認します。最初の確認の後に `set()` が書き込んだアイテムであれば、元の場所に戻します。移している間は、そのキーを読んでもヒットしません。`cleanup()` は、[スケジュールしたコールバック](./scheduling.md#コールバック)などから定期的に呼び出してください。そのときのストアの `path` と `extension` は設定と揃えます。拡張子が違うファイルは対象になりません。

```ts
import { FileCacheStore } from '@guren/core'

const removed = await new FileCacheStore({ path: './storage/cache', extension: '.cache' }).cleanup()
```

## タグ付きキャッシュ

カウンターを加算・減算しても、もとの有効期限はそのまま保たれます。ファイルストアの `add()`、`increment()`、`decrement()` は、ストアのインスタンスどうしやプロセスどうしで共有するファイルシステムのロックを取ります。1 つの書き込み元が 5 秒間持ち続けたロックは、クラッシュしたプロセスが残したものとみなして別の書き込み元が引き継ぐので、キーがロックされたままになることはありません。ただし、その時点で元の書き込み元がまだ動いていた場合（プロセスが一時停止していた、ディスクの応答が遅れていたなど）は、ロックを引き継いだ側と同時に処理が進み、どちらかの更新が失われることがあります。複数のプロセスから更新し、しかも更新を失えないカウンターは、Redis ストアに置いてください。

タグと一緒に使う独自ストアには、アトミックな `add(key, value): Promise<boolean>` が必要です。キーがないときだけ有効期限なしで挿入し、挿入できたかどうかを返してください。組み込みのストアはこの操作を実装していますが、ファイルストアの `add()` は、ロックが引き継がれたときにはアトミックになりません。

タグを付けておくと、関係するキャッシュのアイテムをまとめて無効化できます。

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
import { resolve, type CacheManager } from '@guren/core'

// config/cache.ts が構成したアプリのキャッシュ（CACHE_STORE=redis）
const cache = () => resolve<CacheManager>('cache')

export async function setUserPreferences(
  userId: string,
  preferences: Record<string, unknown>
): Promise<void> {
  await cache().store().set(`user:${userId}:prefs`, preferences, 86400) // 24時間
}

export async function getUserPreferences(
  userId: string
): Promise<Record<string, unknown> | null> {
  return cache().store().get(`user:${userId}:prefs`)
}
```

## テスト

テストには Memory ストアを使います。

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

1. **TTL は中身に合わせる**: データがどのくらいの頻度で変わるかを見て、有効期限を決めます。

2. **関係するデータにはタグを付ける**: エンティティや機能ごとにまとめておけば、無効化が 1 回で済みます。

3. **キャッシュする層を選ぶ**: コントローラーのレスポンスではなく、データベースから取った結果をキャッシュします。

4. **キャッシュミスに備える**: 値が見つからなかったときの処理を必ず用意します。

5. **ジェネリクスで型を指定する**: 値を取り出すときに型を書いておけば、型安全に扱えます。

6. **ヒット率を監視する**: どのくらい効いているかを見ながら、TTL や使い方を調整します。

7. **本番では Redis を使う**: Memory のキャッシュは再起動すると消えます。

8. **機密データはキャッシュしない**: パスワードやトークンなどはキャッシュに入れないでください。

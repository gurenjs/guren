# キャッシュガイド

キャッシュは、データベースのクエリや計算のような重い処理の結果をキーに保存し、次のリクエストですぐに読み出せるようにする仕組みです。`bunx guren add cache` で追加し、`CACHE_STORE` で保存先を選び、コンテナから `cache` として取り出して使います。

## コアコンセプト

- **CacheManager**: 設定したストアをまとめるレジストリ。`config/cache.ts` がコンテナに `cache` としてバインドします
- **CacheStore**: 1 つの保存先に対する操作（get、set、delete など）。`cache.store()` がデフォルトのストアを返します
- **ドライバー**: 保存先の実装。`memory`（デフォルト）、`redis`、`file` があります
- **TaggedCache**: キーをタグでまとめて、一度に削除できるようにするストアの見方

## セットアップ

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

コールバックには検証済みの環境変数が渡されるので、読み取るキーはすべて `config/env.ts` に宣言しておきます。変数の宣言のしかたと、定義が起動時にどう処理されるかは[設定ガイド](./configuration.md)にあります。サービスプロバイダーでキャッシュを設定しているアプリもそのまま動きます（[サービスプロバイダを使うアプリ](./configuration.md#サービスプロバイダを使うアプリ)を参照）。

### 複数のストア

アプリで使う可能性のある保存先をすべて `stores` に宣言し、デフォルトは `CACHE_STORE` で選びます。

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

`CACHE_STORE` の名前は起動時には検査されません。`stores` にない名前を指定すると、そのストアを初めて解決したときに `Cache store not found` が投げられます。

## キャッシュの取り出し

定義が `cache` としてバインドしたマネージャーを解決し、そこからストアを選びます。

| 書く場所 | 取り出し方 |
|----------|------------|
| コントローラー | `this.make('cache')` |
| サービスプロバイダー | `this.container.make('cache')` |
| それ以外（サービス、ジョブ） | `@guren/core` から import した `resolve<CacheManager>('cache')` |

```ts
const cache = this.make('cache') // CacheManager

await cache.store().set('key', 'value')             // デフォルトのストア（CACHE_STORE）
await cache.store('memory').set('temp', 'data', 60) // 名前を指定したストア
```

このページの以降の例では、このマネージャーを `cache` と書きます。

ファサードを使えば、毎回解決しなくても同じマネージャーを使えます。

```ts
import { createFacades } from '@guren/core'

const { Cache } = createFacades(app.container)

await Cache.store().set('user:1', { name: 'John' }, 3600)
```

`new CacheManager()` で作ったマネージャーは、設定を読まないメモリのストアを 1 つだけ持つ別物です。スクリプトや単体テストには向きますが、アプリのコードでは設定済みのマネージャーを共有してください。

## 基本的な使い方

### キャッシュ操作

```ts
const store = cache.store()

// 基本操作
await store.set('key', 'value', 3600)  // TTL 3600 秒で保存
await store.set('key', 'value')         // 有効期限なしで保存
const value = await store.get<string>('key')
const exists = await store.has('key')
await store.delete('key')
await store.clear()                     // 全アイテムを削除

// インクリメント／デクリメント
await store.set('counter', 0)
await store.increment('counter')        // 1
await store.increment('counter', 5)     // 6
await store.decrement('counter', 2)     // 4

// 残りの TTL（秒）
const ttl = await store.ttl('key')      // -1 = 有効期限なし、-2 = 存在しない

// まとめて操作
await store.setMany(new Map([
  ['key1', 'value1'],
  ['key2', 'value2'],
]), 3600)

const values = await store.getMany<string>(['key1', 'key2'])
const deleted = await store.deleteMany(['key1', 'key2'])
```

TTL の単位は秒です。カウンターを加算・減算しても、もとの有効期限は変わりません。

### Remember パターン

`remember` はキャッシュされた値を返し、なければコールバックを実行して、その結果を保存してから返します。

```ts
// 1 時間キャッシュする。なければ計算する
const posts = await cache.store().remember('posts:recent', 3600, async () => {
  return await Post.orderBy('createdAt', 'desc').limit(10).get()
})

// 手動で消すまでキャッシュし続ける
const settings = await cache.store().rememberForever('app:settings', async () => {
  return await Settings.all()
})
```

複数のリクエストが同時に同じキーでミスしても、コールバックは 1 回しか実行されません。そのとき何が共有されるかは[同時ミス](#同時ミス)を参照してください。

## タグ付きキャッシュ

タグを付けておくと、関係するキーをまとめて削除できます。

```ts
// タグ付きで保存
await cache.store().tags(['posts', 'user:1']).set('user:1:posts', posts, 3600)
await cache.store().tags(['posts', 'user:2']).set('user:2:posts', posts, 3600)
await cache.store().tags(['comments', 'user:1']).set('user:1:comments', comments)

// タグ付きのアイテムを取得
const userPosts = await cache.store().tags(['posts', 'user:1']).get('user:1:posts')

// 指定したタグを持つアイテムをすべて削除
await cache.store().tags(['user:1']).flush()  // user:1:posts と user:1:comments が消える

// 投稿をすべて削除
await cache.store().tags(['posts']).flush()   // 投稿のキャッシュがすべて消える
```

### よく使うタグの付け方

```ts
// モデル単位のキャッシュ
await cache.store().tags([`posts`, `post:${post.id}`]).set(`post:${post.id}`, post)

// 更新したら無効化
await post.save()
await cache.store().tags([`post:${post.id}`]).flush()

// 投稿をすべて無効化
await cache.store().tags(['posts']).flush()

// ユーザーごとのキャッシュ
await cache.store().tags([`user:${userId}`, 'dashboard']).set(
  `user:${userId}:dashboard`,
  dashboardData,
  300
)

// ログアウト時にユーザーのデータをすべて削除
await cache.store().tags([`user:${userId}`]).flush()
```

組み込みのストアはどれもタグに対応しています。タグと一緒に使う独自ストアには、アトミックな `add(key, value): Promise<boolean>` が必要です。キーがないときだけ有効期限なしで挿入し、挿入できたかどうかを返してください。

## ユースケース

### データベースクエリのキャッシュ

```ts
import { resolve, type CacheManager } from '@guren/core'
import { Post } from '@/app/Models/Post'

const cache = () => resolve<CacheManager>('cache')

export async function getRecentPosts(): Promise<Post[]> {
  return cache().store().remember('posts:recent', 300, async () => {
    return await Post.orderBy('createdAt', 'desc').limit(10).get()
  })
}

export async function getPost(id: number): Promise<Post | null> {
  return cache().store().tags(['posts', `post:${id}`]).remember(
    `post:${id}`,
    3600,
    async () => Post.find(id)
  )
}

// 投稿を更新したら無効化
export async function updatePost(id: number, data: Partial<Post>): Promise<void> {
  await Post.where('id', id).update(data)
  await cache().store().tags([`post:${id}`]).flush()
}
```

### レート制限のデータ

```ts
import { resolve, type CacheManager } from '@guren/core'

const cache = () => resolve<CacheManager>('cache')

export async function checkRateLimit(ip: string, limit: number): Promise<boolean> {
  const key = `ratelimit:${ip}`
  const current = await cache().store().get<number>(key) ?? 0

  if (current >= limit) {
    return false
  }

  await cache().store().increment(key)

  // 最初のリクエストでだけ TTL を設定
  if (current === 0) {
    await cache().store().set(key, 1, 60) // 1 分間の枠
  }

  return true
}
```

リクエストを制限するだけなら、[レート制限のミドルウェア](./rate-limiting.md)がすでにこの処理を行います。

### セッションに近いデータ

```ts
import { resolve, type CacheManager } from '@guren/core'

// config/cache.ts が構成したアプリのキャッシュ（CACHE_STORE=redis）
const cache = () => resolve<CacheManager>('cache')

export async function setUserPreferences(
  userId: string,
  preferences: Record<string, unknown>
): Promise<void> {
  await cache().store().set(`user:${userId}:prefs`, preferences, 86400) // 24 時間
}

export async function getUserPreferences(
  userId: string
): Promise<Record<string, unknown> | null> {
  return cache().store().get(`user:${userId}:prefs`)
}
```

## 同時ミス

同じプロセスの中で、同じキー・同じ TTL の呼び出しが同時にキャッシュミスした場合、コールバックは 1 回だけ実行され、その呼び出し元は全員が同じ結果を受け取ります。成功すれば同じオブジェクトを、失敗すれば同じ例外を受け取ります。例外を投げたコールバックは何もキャッシュしないので、次の呼び出しでもう一度実行されます。ヒットは共有されず、同時にヒットした呼び出しはそれぞれ `get()` が返す値を受け取ります。

コールバックを共有する呼び出しは次のとおりです。

- `cache.store()` で取り出したストアと、タグ付きキャッシュでの `remember` と `rememberForever`。`registerStore()` で追加したストアや、`new TaggedCache(store, tags)` で作ったタグ付きキャッシュも含みます。
- 同じストアインスタンスを通した呼び出しに限ります。`CacheManager` が 2 つある場合や、同じ Redis を指すストア名が 2 つある場合は、それぞれがコールバックを実行します。
- `new MemoryStore()` や `new FileStore(...)` のように自分で作って直接呼ぶストアは、共有しません。
- プロセス（Cloudflare Workers では isolate）をまたいでは共有しません。別々のサーバーが同時に同じキーでミスすれば、それぞれがコールバックを実行します。

気をつける点は次のとおりです。

- **結果は読み取り専用として扱います。** 一緒にミスした呼び出し元は同じオブジェクトを受け取るので、1 つの呼び出し元が加えた変更はほかからも見えます。変更したいときは、先に `structuredClone(posts)` のようにコピーしてください。メモリストアはヒットのときも保存したオブジェクトそのものを返すので、変更するとキャッシュ内の値まで変わります。
- **コールバックをリクエストに依存させません。** コールバックは相乗りしたすべての呼び出し元のために実行されます。最初のリクエストの `AbortSignal` は渡さず、ログイン中のユーザーやロケールといったリクエストの状態も、キーに含めていない限り読まないでください。最初の呼び出し元のリクエストが原因の失敗（中断など）は、相乗りした全員に届きます。
- **TTL が違う呼び出しは共有しません。** `rememberForever` も、それだけで 1 つの TTL として扱われます。各コールバックは自分の呼び出し元の TTL で結果を保存し、最後に終わったものが残ります。たとえば `rememberForever` の後に `remember(key, 60, ...)` が終わると、エントリは 60 秒で期限切れになります。
- **10 秒を過ぎると共有をやめます。** 実行中のコールバックが始まってから 10 秒以上たって届いた呼び出しは、待たずに自分のコールバックを実行します。すでに待っている呼び出し元は最初のコールバックを待ち続けるので、コールバックの中の遅い I/O にはそれぞれタイムアウトを設定してください。
- **書き込むと次から別のコールバックになります。** 同じストアインスタンスを通してそのキーに書き込むと（`set`、`delete`、`setMany`、`deleteMany`、`clear`、タグ付きキャッシュの `set` と `delete`）、その後のミスは新しくコールバックを実行します。実行中のコールバックは取り消されず、終わった時点で結果を保存するので、書き込んだ値が上書きされることがあります。

## ドライバーのオプション

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

### ファイルストアの掃除

期限切れのアイテムを `get()`、`has()`、`ttl()` で読むと、キーは存在しないものとして扱われますが、ファイルはディスクに残ります。期限切れのファイルは、`cleanup()` を定期的に呼んで削除してください。たとえば[スケジュールしたコールバック](./scheduling.md#コールバック)から、設定と同じ `path` と `extension` のストアで呼びます（拡張子が違うファイルは対象になりません）。

```ts
import { FileCacheStore } from '@guren/core'

const removed = await new FileCacheStore({ path: './storage/cache', extension: '.cache' }).cleanup()
```

`cleanup()` は、書き込みが続いている最中に実行しても問題ありません。`add()`、`increment()`、`decrement()`、`delete()` と同じキー単位のロックを取ってから期限切れのファイルを別の場所に移し、もう一度確認します。その間に `set()` が書き込んだアイテムであれば、元の場所に戻します。移している間は、そのキーを読んでもヒットしません。

### ファイルストアのカウンター

ファイルストアの `add()`、`increment()`、`decrement()` は、ストアのインスタンスどうしやプロセスどうしで共有するファイルシステムのロックを取ります。5 秒間持ち続けられたロックは、クラッシュしたプロセスが残したものとみなして引き継がれるので、キーがロックされたままになることはありません。ただし、元の書き込み元が遅れていただけ（プロセスの一時停止、ディスクの応答遅れなど）なら、引き継いだ側と同時に処理が進み、どちらかの更新が失われることがあります。複数のプロセスから更新し、しかも更新を失えないカウンターは、Redis ストアに置いてください。

## テスト

### `container.fake()` を使う

1 つのテストの間だけアプリに新しいメモリのキャッシュを使わせるには、`container.fake()` で新しい `CacheManager` を `cache` にバインドします。`using` で受け取っておけば、テストの終わりに本来のマネージャーに戻ります。

```ts
import { beforeAll, describe, expect, test } from 'bun:test'
import { CacheManager } from '@guren/core'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

describe('Cache in application code', () => {
  beforeAll(async () => {
    await TestApp.fromApp(app)
  })

  test('uses a fake cache manager', async () => {
    using _ = app.container.fake('cache', new CacheManager())

    // 'cache' を解決するもの（ファサードを含む）はすべてフェイクを受け取る
    const cache = app.container.make('cache')
    await cache.store().set('key', 'value', 3600)
    expect(await cache.store().get('key')).toBe('value')
  })
})
```

### メモリストアを直接使う

キャッシュを使うロジックだけを単体でテストするなら、テストごとにマネージャーを作ります。

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { CacheManager } from '@guren/core'

describe('Cache', () => {
  let cache: CacheManager

  beforeEach(async () => {
    cache = new CacheManager()
    await cache.store().clear()
  })

  test('stores and retrieves values', async () => {
    await cache.store().set('key', 'value', 3600)
    const value = await cache.store().get<string>('key')
    expect(value).toBe('value')
  })

  test('remember caches callback result', async () => {
    let callCount = 0

    const getValue = () => cache.store().remember('computed', 3600, async () => {
      callCount++
      return 'computed-value'
    })

    await getValue()
    await getValue()

    expect(callCount).toBe(1) // コールバックは 1 回だけ呼ばれる
  })

  test('tagged cache flushes correctly', async () => {
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

1. **TTL はデータが変わる頻度で決めます。** フィードは短く、設定値は長くします。
2. **関係するデータにはタグを付けます。** エンティティや機能ごとにまとめておけば、1 回の `flush()` で無効化できます。
3. **レスポンスではなくデータをキャッシュします。** コントローラーのレスポンス全体ではなく、クエリの結果や計算結果をキャッシュします。
4. **本番では Redis を使います。** メモリストアはプロセスごとに分かれ、再起動すると空になります。
5. **秘密の値はキャッシュしません。** パスワードやトークンなどの認証情報はキャッシュに入れないでください。

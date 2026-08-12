# テストガイド

よく書かれた一つのテストは、ユーザーより先にバグを見つけてくれます。Guren はテストを書くことがブラウザで手動確認するより速く感じられるほど便利にできています。

## TestApp

`TestApp` は、アプリケーションの HTTP レイヤーをテストするための高レベルで表現力豊かな API を提供します。ミドルウェアとルーティングスタック一式を備えた軽量なアプリケーションインスタンスを起動し、リクエストの送信と Fluent インターフェースによるレスポンスのアサーションが可能です。

### TestApp の作成

```ts
import { describe, test, beforeAll } from 'bun:test'
import { TestApp } from '@guren/testing'

describe('Posts API', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await TestApp.create()
  })

  test('全投稿を一覧表示する', async () => {
    await app.get('/posts')
      .assertOk()
      .assertJsonCount(3, 'data')
  })

  test('新しい投稿を作成する', async () => {
    await app.post('/posts', {
      title: 'Test Post',
      content: 'Hello world',
    })
      .assertStatus(201)
      .assertJsonPath('post.title', 'Test Post')
  })
})
```

### 実アプリをラップする

`TestApp.create({ ... })`は渡したパーツからアプリを組み立てます — 単体スライスのテストには便利ですが、その部分集合はサーバーが実際に動かす構成(プロバイダー、`auth`、`i18n`、セキュリティデフォルト)から静かにドリフトし得ます。実構成を検証したいテストでは、プロジェクトがエクスポートするアプリをラップします:

```ts
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

let http: TestApp

beforeAll(async () => {
  http = await TestApp.fromApp(app)
})

test('ホームページを返す', async () => {
  await http.get('/').assertOk()
})
```

`fromApp()`はアプリのbootとfetchハンドラの束縛を代わりに行います。同じインスタンスに対して複数のテストファイルから呼んで構いません — `boot()`は冪等で、最初のbootを再利用します。

同じことを手作業で行う次の長い形も見かけるでしょう。アロー関数に注目してください — `fetch`はインスタンス状態を読むため、束縛していない`app.fetch`をそのまま`fromFetch`に渡すと最初のリクエストで例外になります。`fromApp()`はこの罠を取り除くために存在します。`fromFetch`は、Gurenアプリケーションではなく任意のfetch関数を持っている場合に使ってください。

```ts
await app.boot()
http = TestApp.fromFetch((request) => app.fetch(request))
```

パーツから組み立てる場合、`TestApp.create()`は`createApp`のオプションをミラーします: セッション+CSRFミドルウェアには`auth`を、テスト対象のコントローラーが`this.t()` / `this.tc()`を使うなら`i18n`を渡します:

```ts
const app = await TestApp.create({
  routes: registerWebRoutes,
  i18n: { supported: ['en'] },
})
```

### リクエストの送信

TestApp は標準的な HTTP メソッドをすべてサポートしています。

```ts
await app.get('/posts')
await app.post('/posts', body)
await app.put('/posts/1', body)
await app.patch('/posts/1', body)
await app.delete('/posts/1')
await app.query('/posts/search', body) // HTTP QUERY (RFC 10008)
```

### Fluent アサーション

レスポンスに対してアサーションを直接チェーンできます。

```ts
// ステータスのアサーション
await app.get('/posts').assertOk()                    // 200
await app.get('/posts').assertStatus(200)
await app.post('/posts', data).assertStatus(201)
await app.get('/missing').assertNotFound()             // 404
await app.get('/secret').assertForbidden()             // 403
await app.get('/secret').assertUnauthorized()           // 401
await app.delete('/posts/1').assertNoContent()         // 204

// JSON のアサーション
await app.get('/posts').assertJson({ data: [] })
await app.get('/posts').assertJsonCount(3, 'data')
await app.get('/posts/1').assertJsonPath('post.title', 'Hello')
await app.get('/posts').assertJsonStructure(['data', 'meta'])

// ヘッダーのアサーション
await app.get('/posts').assertHeader('content-type', 'application/json')

// リダイレクトのアサーション
await app.get('/old-page').assertRedirect('/new-page')
```

### テストでの認証

`actingAs()` を使って認証済みユーザーをシミュレートします。

```ts
import { User } from '@/app/Models/User'

const user = await User.create({
  email: 'test@example.com',
  name: 'Test User',
})

// このチェーンを通じたすべてのリクエストは、指定したユーザーとして認証されます
await app.actingAs(user).get('/dashboard').assertOk()
await app.actingAs(user).post('/posts', data).assertStatus(201)

// 認証なしの場合、保護されたルートは 401/リダイレクトを返します
await app.get('/dashboard').assertUnauthorized()
```

### カスタムリクエストヘッダー

`withHeaders()` / `withHeader()` で全リクエストにヘッダーを付与できます。
ロケール検出・API バージョニング・Bearer トークンなどに便利です。
`actingAs()` や `json()` と同様に新しい `TestApp` を返すので、自由に合成できます。

```ts
// Accept-Language でロケールを切り替えてレンダリング
const en = app.withHeaders({ 'Accept-Language': 'en' })
await en.get('/').assertOk()

// API トークン認証と JSON モードの合成
await app
  .withHeader('Authorization', `Bearer ${token}`)
  .json()
  .get('/api/me/tasks')
  .assertOk()
```

### コンテナフェイクを使ったテスト

コンテナの `fake()` メソッドを使って、サービスをテストダブルに置き換えられます。

```ts
import { TestApp } from '@guren/testing'
import { FakeEvent, FakeMail, FakeQueue } from '@guren/testing'

const app = await TestApp.create()

// 実際のサービスをフェイクに置き換える
const fakeEvents = new FakeEvent()
const fakeMail = new FakeMail()
app.container.fake('events', fakeEvents)
app.container.fake('mail', fakeMail)

// リクエストを送信し、副作用をアサートする
await app.post('/users', { email: 'new@test.com', name: 'New User' })
  .assertStatus(201)

fakeEvents.assertDispatched(UserRegistered)
fakeMail.assertSentTo('new@test.com')
```

### `@guren/testing` でコントローラーをテストする

`@guren/testing` パッケージには、コントローラーテスト向けのヘルパーが用意されています。

- `createControllerContext(url, init?)` — コントローラー用の Hono コンテキストを構築します。
- `createGurenControllerModule()` — Vitest 実行時に `guren` パッケージをモックし、コントローラーを分離してテストできるようにします。
- `createControllerModuleMock()` — `@guren/core` の `Controller`、`json`、`redirect` を Vitest 向けに配線したドロップインモックです。
- `readInertiaResponse(response)` — Inertia レスポンスを `{ format, payload, body }` に正規化し、アサーションを簡単にします。

これらのユーティリティを Vitest スイート（例: `examples/blog/tests`）にインポートすれば、Bun 固有の API を避けつつ、React/Inertia コントローラーテストを表現力豊かに書けます。

### トラブルシューティング

- `vi.mock is not a function` が表示される場合、そのテストは Bun で実行されています。上記の Vitest コマンドに切り替えてください。
- `ReferenceError: document is not defined` は、DOM 依存のテストが jsdom の外で実行されていることを示しています。Vitest ランナーを使うか、jsdom を明示的に設定してください。

ランナーを分離することで、フレームワークコードには Bun の高速フィードバックを、SPA テストにはリアルな DOM 動作を両立できます。

## テスト用フェイク

`@guren/testing` パッケージは、テスト用のサービスのフェイク実装を提供します。実際にメール送信、イベントディスパッチ、ジョブキューイングを行わずにコードをテストできます。

### FakeMail

実際にメールを送信せずにメール送信をテストします。

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { FakeMail } from '@guren/testing'

describe('ユーザー登録', () => {
  let fakeMail: FakeMail

  beforeEach(() => {
    fakeMail = new FakeMail()
  })

  it('ウェルカムメールを送信する', async () => {
    await userService.register({ email: 'user@example.com' })

    fakeMail.assertSent(WelcomeEmail)
    fakeMail.assertSentTo('user@example.com')
  })

  it('正しい件名でメールを送信する', async () => {
    await userService.register({ email: 'user@example.com' })

    fakeMail.assertSentWith(WelcomeEmail, {
      subject: 'Welcome to our app!',
    })
  })
})
```

#### FakeMail メソッド

| メソッド | 説明 |
|--------|-------------|
| `assertSent(mailable)` | メールが送信されたことをアサート |
| `assertSentTimes(mailable, count)` | メールが正確な回数送信されたことをアサート |
| `assertNotSent(mailable)` | メールが送信されなかったことをアサート |
| `assertNothingSent()` | メールが一切送信されなかったことをアサート |
| `assertSentTo(email)` | 指定アドレスにメールが送信されたことをアサート |
| `assertSentWith(mailable, data)` | 特定のデータでメールが送信されたことをアサート |
| `assertQueuedCount(count)` | キューに入れられたメールの件数をアサート |
| `sent(mailable)` | 送信されたメールのインスタンスをすべて取得 |

### FakeQueue

ジョブを実際に処理せずにジョブのディスパッチをテストします。

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { FakeQueue } from '@guren/testing'

describe('注文処理', () => {
  let fakeQueue: FakeQueue

  beforeEach(() => {
    fakeQueue = new FakeQueue()
  })

  it('注文処理ジョブをディスパッチする', async () => {
    await orderService.create(orderData)

    fakeQueue.assertPushed(ProcessOrderJob)
    fakeQueue.assertPushedWith(ProcessOrderJob, {
      orderId: expect.any(Number),
    })
  })

  it('無効な注文ではジョブをディスパッチしない', async () => {
    await orderService.create(invalidData)

    fakeQueue.assertNotPushed(ProcessOrderJob)
  })
})
```

#### FakeQueue メソッド

| メソッド | 説明 |
|--------|-------------|
| `assertPushed(job)` | ジョブがプッシュされたことをアサート |
| `assertPushedTimes(job, count)` | ジョブが正確な回数プッシュされたことをアサート |
| `assertPushedOn(queue, job)` | 特定のキューにジョブがプッシュされたことをアサート |
| `assertPushedWith(job, data)` | 特定のデータでジョブがプッシュされたことをアサート |
| `assertNotPushed(job)` | ジョブがプッシュされなかったことをアサート |
| `assertNothingPushed()` | ジョブが一切プッシュされなかったことをアサート |
| `pushed(job)` | プッシュされたジョブのインスタンスをすべて取得 |

### FakeEvent

リスナーをトリガーせずにイベントのディスパッチをテストします。

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { FakeEvent } from '@guren/testing'

describe('ユーザーアクション', () => {
  let fakeEvent: FakeEvent

  beforeEach(() => {
    fakeEvent = new FakeEvent()
  })

  it('ユーザー登録イベントをディスパッチする', async () => {
    await userService.register(userData)

    fakeEvent.assertDispatched(UserRegistered)
  })

  it('正しい順序でイベントをディスパッチする', async () => {
    await userService.register(userData)

    fakeEvent.assertDispatchedInOrder([
      UserCreated,
      UserRegistered,
      WelcomeEmailSent,
    ])
  })

  it('正しいデータでイベントをディスパッチする', async () => {
    await userService.register({ email: 'test@example.com' })

    fakeEvent.assertDispatchedWith(UserRegistered, {
      email: 'test@example.com',
    })
  })
})
```

#### FakeEvent メソッド

| メソッド | 説明 |
|--------|-------------|
| `assertDispatched(event, callback?)` | イベントがディスパッチされたことをアサート |
| `assertDispatchedTimes(event, count)` | イベントが正確な回数ディスパッチされたことをアサート |
| `assertNotDispatched(event)` | イベントがディスパッチされなかったことをアサート |
| `assertNothingDispatched()` | イベントが一切ディスパッチされなかったことをアサート |
| `assertDispatchedInOrder(events)` | イベントが特定の順序でディスパッチされたことをアサート |
| `assertDispatchedWith(event, data)` | 特定のデータでイベントがディスパッチされたことをアサート |
| `dispatched(event)` | ディスパッチされたイベントのインスタンスをすべて取得 |

### テストデータベースの分離

`bun test` は `NODE_ENV=test` を自動的に設定します。新規にスキャフォールドされたプロジェクトの `config/database.ts` はこれを利用して、テストが開発用データベースにまったく触れないようにしています。

```ts
// config/database.ts
function resolveDatabaseFilename(): string {
  if (process.env.NODE_ENV === 'test') {
    return process.env.TEST_DATABASE_URL ?? './data/guren.test.db'
  }
  return process.env.DATABASE_URL ?? './data/guren.db'
}
```

テストはデフォルトで `./data/guren.db` とは別ファイルの `./data/guren.test.db` を読み書きします。そのため、テストが作成したデータが開発サーバーで見ているデータに混ざることはありません。テスト用ファイル自体は `TEST_DATABASE_URL` で上書きできます(例: 並列実行する CI シャードごとに別ファイルを割り当てる場合)。それ以外の環境では引き続き `DATABASE_URL` が優先されます。

> [!WARNING]
> このブランチが導入される前にスキャフォールドされたプロジェクトは、`NODE_ENV` に関係なく `DATABASE_URL`(または `./data/guren.db`)へ直接書き込みます。そのため `bun test` が開発サーバーと同じデータベースを汚染してしまいます。後付けする際はヘルパー関数を追加するだけでなく `filename` オプション自体を差し替えてください — ヘルパーを定義しただけでは `createSqliteDatabase()` がまだ古い `filename` を参照したままなので効果がありません:
>
> ```diff
>  import { createSqliteDatabase } from '@guren/orm'
>
> +function resolveDatabaseFilename(): string {
> +  if (process.env.NODE_ENV === 'test') {
> +    return process.env.TEST_DATABASE_URL ?? './data/guren.test.db'
> +  }
> +  return process.env.DATABASE_URL ?? './data/guren.db'
> +}
> +
>  const database = createSqliteDatabase({
>    migrationsFolder: new URL('../db/migrations', import.meta.url),
>    seedersFolder: new URL('../db/seeders', import.meta.url),
> -  filename: () => process.env.DATABASE_URL ?? './data/guren.db',
> +  filename: resolveDatabaseFilename,
>  })
> ```

### データのクリーンアップ

ほとんどのスイートでは、テスト専用ファイルによる分離だけで十分です。`config/database.ts` がすでにエクスポートしている `resetDatabase()` / `migrateDatabase()` を `beforeEach` で使い、クリーンな状態にリセットしましょう。

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { resetDatabase, migrateDatabase } from '@/config/database'

describe('User モデル', () => {
  beforeEach(async () => {
    await resetDatabase()   // すべてのテーブルを削除
    await migrateDatabase() // マイグレーションを最初から再適用
  })

  it('ユーザーを作成する', async () => {
    const user = await User.create({
      email: 'test@example.com',
      name: 'Test User',
    })

    expect(user.id).toBeDefined()
    expect(user.email).toBe('test@example.com')
  })
})
```

`@guren/testing` には、よりきめ細かいテストごとのクリーンアップ用に `useTruncateTables(tables)` と `useDatabaseTransactions()` も用意されています。`useTruncateTables()` は各テーブルの行を削除する `beforeEach` フックのみを登録し、`useDatabaseTransactions()` はトランザクションを開始してテスト後にロールバックする `beforeEach`/`afterEach` フックを登録します。どちらも、事前に `setTestDatabase()` で登録した以下の形の接続に対して動作します。

```typescript
interface DatabaseConnection {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<void>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}
```

Guren の SQLite アダプターはこの `DatabaseConnection` をそのまま提供しません — `config/database.ts` の `getDatabase()` が解決するのは内部の Drizzle インスタンスであり、このインターフェースとは形が異なります。そのため、これらのヘルパーを使うにはアダプターを自分で書き、テスト実行前に `setTestDatabase()` へ渡す必要があります。**同一の接続でなければならない**という制約があるのは `useDatabaseTransactions()` だけです — `beforeEach` でトランザクションを開始し `afterEach` でロールバックするため、同じファイルへ独立に開いた 2 本目の接続では 1 本目の接続で行った書き込みが見えず、ロールバックもされません。`useTruncateTables()` にはこの制約はありません — `DELETE FROM` は即座にコミットされる操作なので、同じデータベースファイルへの接続であればどれを使ってもモデル側から見える行を削除できます。アダプターの配線が過剰だと感じる場合は、上記の `resetDatabase()` / `migrateDatabase()` パターンの方がシンプルで、この問題自体を回避できます。

### HTTP テスト

HTTP エンドポイントのテストには TestApp（推奨）または低レベルのコントローラーテストヘルパーを使います。

```typescript
import { describe, it, expect } from 'bun:test'
import { TestApp } from '@guren/testing'

describe('UserController', () => {
  it('ユーザー一覧を返す', async () => {
    const app = await TestApp.create()

    await app.get('/users').assertOk()
  })

  it('新しいユーザーを作成する', async () => {
    const app = await TestApp.create()

    await app.post('/users', {
      email: 'new@example.com',
      name: 'New User',
    }).assertStatus(201)
  })

  it('ダッシュボードへのアクセスには認証が必要', async () => {
    const app = await TestApp.create()
    const user = await User.create({ email: 'test@example.com', name: 'Test' })

    await app.get('/dashboard').assertUnauthorized()
    await app.actingAs(user).get('/dashboard').assertOk()
  })
})
```

低レベルのコントローラーユニットテストには、`createControllerContext` も引き続き使えます。

```typescript
import { createControllerContext } from '@guren/testing'
import UserController from '../app/Http/Controllers/UserController'

it('ユーザー一覧を返す', async () => {
  const ctx = createControllerContext('/users')
  const controller = new UserController()
  controller.setContext(ctx)

  const response = await controller.index()
  expect(response.status).toBe(200)
})
```

### ベストプラクティス

1. **ほとんどのテストには TestApp を使う** - ミドルウェアとルーティング一式を含む、最もリアルなテスト環境を提供します。
2. **beforeEach でフェイクをリセットする** - 常にクリーンな状態から始めましょう。
3. **具体的なアサーションを使う** - 可能な限り `assertSent` より `assertSentWith` を優先しましょう。
4. **失敗ケースをテストする** - エラーシナリオでイベントやメールが送信されないことを検証しましょう。
5. **テストを分離する** - 各テストは独立している必要があります。
6. **認証には `actingAs()` を使う** - テストでセッションデータを手動設定するのは避けましょう。
7. **コンテナフェイクを使う** - import のモックではなく、`container.fake()` でサービスを置き換えましょう。

## テストの実行

```bash
# テストスイート全体
bun run test

# サーバーサイドコード（Bun のテストランナー）
bun run test:bun

# フロントエンド / サンプルアプリ（Vitest）
bun run test:examples

# 単一ファイル
bun test path/to/file.test.ts

# テストファイルを生成
bunx guren make:test posts/PostController --runner bun
```

> [!NOTE]
> サーバーサイドのコードは Bun ネイティブのテストランナー（`bun:test`）を使います。フロントエンドや React コンポーネントは jsdom を使う Vitest でテストします。フレームワークコードは Bun の高速なフィードバックを、SPA テストはリアルな DOM 挙動を、それぞれ得られるようランナーを使い分けています。

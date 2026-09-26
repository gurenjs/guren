# テストガイド

よく書かれた一つのテストは、ユーザーより先にバグを見つけてくれます。Guren では、ブラウザで手動確認するよりテストを書くほうが速いと感じられるようにしています。

## TestApp

`TestApp` は、アプリケーションの HTTP レイヤーをテストするための API です。ミドルウェアとルーティングスタック一式を備えた軽量なアプリケーションインスタンスを起動し、リクエストの送信と、Fluent インターフェースによるレスポンスのアサーションができます。

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

`TestApp.create({ ... })` は渡したパーツからアプリを組み立てます。単体スライスのテストには便利ですが、その部分集合はサーバーが実際に動かす構成(プロバイダー、`auth`、`i18n`、セキュリティデフォルト)から知らないうちにずれていきます。実構成を検証したいテストでは、プロジェクトがエクスポートするアプリをラップしてください:

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

`fromApp()` はアプリの boot と fetch ハンドラの束縛を代わりに行います。同じインスタンスに対して複数のテストファイルから呼んで構いません。`boot()` は冪等で、最初の boot を再利用します。

同じことを手作業で行う、次の長い書き方もあります。アロー関数に注目してください。`fetch` はインスタンス状態を読むため、束縛していない `app.fetch` をそのまま `fromFetch` に渡すと最初のリクエストで例外になります。`fromApp()` はこの罠を取り除くためにあります。`fromFetch` は、Guren アプリケーションではなく任意の fetch 関数を持っている場合に使ってください。

```ts
await app.boot()
http = TestApp.fromFetch((request) => app.fetch(request))
```

パーツから組み立てる場合、`TestApp.create()` は `createApp` と同じオプションを受け取ります: セッションと CSRF のミドルウェアが必要なら `auth` を、テスト対象のコントローラーが `this.t()` / `this.tc()` を使うなら `i18n` を渡します:

```ts
const app = await TestApp.create({
  routes: registerWebRoutes,
  i18n: { supported: ['en'] },
})
```

`process.env` を書き換えずに環境変数を 1 つだけ試すには、`config/env.ts` のスキーマを `env` に、上書きする値を `envSource` に渡します。`envSource` は `process.env` より先に読まれ、`''` を渡した変数は未設定として扱われます。`create()` は `config` 配列を受け取らないため、上書きが届くのはプロバイダーやコントローラーが `this.make('env')` で読む値です。不正な値を渡すと `create()` は `EnvValidationError` で reject します:

```ts
import { TestApp } from '@guren/testing'
import env from '../config/env.js'

const app = await TestApp.create({
  env,
  envSource: { CACHE_STORE: 'memory', APP_URL: '' },
  providers: [ReportProvider],
})
```

`TestApp.fromApp(app)` は `src/app.ts` が `createApp()` に渡すスキーマと config 定義で起動するので、機能テストは本番と同じ設定で動きます。詳しくは[設定](./configuration.md#テスト)を参照してください。

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

### テストでのパスワードハッシュ

パスワードのテストを速く保つための設定は要りません。`TestApp` が `GUREN_TESTING=1` を設定し、この変数がある間、既定のハッシャーは軽量なパラメータを使います(scrypt を N=1024、`hasher: 'argon2'` なら Argon2id を 1 MiB・1 反復)。本番強度のハッシュは 1 回 100ms 以上かかるため、次のようなテストでは実行時間の大半をそこで使ってしまいます。

```ts
const user = await User.create({ email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' })
await app.post('/login', { email: 'ada@example.com', password: 'correct horse battery' }).assertRedirect('/')
```

それでも、ログインのテストが検証するのは本物のハッシュです。検証はハッシュに埋め込まれたパラメータを読むので、テストでは軽量なハッシュが、本番では本番のハッシュが、どちらも同じように検証されます。テスト外では `Hash.needsRehash()` が軽量なハッシュを古いものとして報告するので、[暗号化ガイド](./encryption.md)の rehash-on-login パターンが、テストモードのプロセスが書いた行を昇格させます。デプロイしたアプリでこの変数を設定するものはありません。

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

### `@guren/testing` でコントローラーをテストする

`@guren/testing` パッケージには、コントローラーテスト向けのヘルパーが用意されています。

- `createControllerContext(url, init?)`: コントローラー用の Hono コンテキストを構築します。
- `createGurenControllerModule()`: Vitest 実行時に `guren` パッケージをモックし、コントローラーを分離してテストできるようにします。
- `createControllerModuleMock()`: `vi.mock('@guren/core', …)` に渡すモックです。`Controller` はフレームワーク本体の `Controller` を継承し、起動済みアプリが必要な `inertia()` と `make()` の解決先だけを差し替えます。
- `readInertiaResponse(response)`: Inertia レスポンスを `{ format, payload, body }` に正規化し、アサーションを簡単にします。

これらのユーティリティを Vitest スイート（例: `examples/blog/tests`）にインポートすれば、Bun 固有の API を避けつつ React/Inertia のコントローラーテストを書けます。

### トラブルシューティング

- `vi.mock is not a function` が表示される場合、そのテストは Bun で実行されています。上記の Vitest コマンドに切り替えてください。
- `ReferenceError: document is not defined` は、DOM 依存のテストが jsdom の外で実行されていることを示しています。Vitest ランナーを使うか、jsdom を明示的に設定してください。
- jsdom 環境では、`FormData` に入れて送った `File` がアクションに届きません。`createControllerContext(url, { method: 'POST', body: formData })` で `this.file()` を呼ぶアクションをテストすると起きます。jsdom はグローバルの `File` と `Blob` を独自のクラスに置き換えるため、undici が multipart ボディの組み立てと解析に使うクラスと一致しません。Vitest と Node のバージョンによって、テストがタイムアウトする、undici の内部で失敗する、`this.file()` が `null` を返してアップロードが失われたままテストが通る、のいずれかになります。コントローラーテストは DOM を描画しないので、ファイルの先頭行に次のコメントを書いて Node 環境で実行してください。

  ```ts
  // @vitest-environment node
  import { describe, expect, it } from 'vitest'
  ```

ランナーを分けることで、フレームワークコードには Bun の高速なフィードバックを、SPA テストにはリアルな DOM 動作を、それぞれ確保できます。

## サービスのフェイク

テストで本物のメールを送ったり、本物のイベントをディスパッチしたり、キューにジョブを積んだりするのは避けます。`@guren/testing` にはそれぞれのフェイク `fakeEvent()`、`fakeMail()`、`fakeQueue()` があります。プロジェクトが export するアプリに対し、フェイクが必要なテストの中で `app.container.fake()` を使ってバインドします。

```ts
import { beforeAll, test } from 'bun:test'
import { MailManager, createQueueManager } from '@guren/core'
import { TestApp, fakeEvent, fakeMail, fakeQueue } from '@guren/testing'
import app from '../src/app.js'
import { OrderPlaced } from '../app/Events/OrderPlaced.js'
import { ProcessOrderJob, type ProcessOrderPayload } from '../app/Jobs/ProcessOrderJob.js'

let http: TestApp

beforeAll(async () => {
  http = await TestApp.fromApp(app)
})

test('placing an order announces it', async () => {
  const events = fakeEvent()
  using _events = app.container.fake('events', events.getManager())

  const client = await http.withCsrf()
  await client.post('/orders', { sku: 'book' }).assertRedirect('/orders')

  events.assertDispatched(OrderPlaced, (event) => event.sku === 'book')
})

test('placing an order mails a receipt', async () => {
  const mail = fakeMail()
  const manager = new MailManager({ default: 'fake', from: { email: 'shop@example.com', name: 'Shop' } })
  manager.registerTransport('fake', () => mail.getTransport())
  using _mail = app.container.fake('mail', manager)

  const client = await http.withCsrf()
  await client.post('/orders', { sku: 'book', email: 'ada@example.com' }).assertRedirect('/orders')

  mail.assertSentTo('ada@example.com')
  mail.assertSentWithSubject('Your order')
})

test('placing an order queues the processing job', async () => {
  const queue = fakeQueue()
  using _queue = app.container.fake(
    'queue',
    createQueueManager({ default: 'fake', drivers: { fake: () => queue.getDriver() } }),
  )

  const client = await http.withCsrf()
  await client.post('/orders', { sku: 'book' }).assertRedirect('/orders')

  queue.assertPushed<ProcessOrderPayload>(ProcessOrderJob, (payload) => payload.sku === 'book')
})
```

コンテナの各キーが保持するのはマネージャーです（`events` は `EventManager`、`mail` は `MailManager`、`queue` は `QueueManager`）。フェイクはその一段下の部品なので、マネージャーに包んでからバインドします。

- `fakeEvent()` は内部に持つマネージャーを通して記録します。`events.getManager()` をバインドしてください。このマネージャーにはリスナーが登録されないので、リスナーは実行されず、リスナーが始めるはずのジョブやメールも動きません。
- `fakeMail()` はトランスポートです。本物の `MailManager` に登録し、そのマネージャーをバインドします。
- `fakeQueue()` はドライバーです。`createQueueManager()` のファクトリーから返し、そのマネージャーをバインドします。

`assertPushed` にはペイロードの型を明示的に渡します。ジョブクラスだけでは TypeScript にペイロードの型が伝わらず、述語の引数が `unknown` になります。

`fake()` は破棄可能なオブジェクト（disposable）を返すので、`using` で受けるとテストの終了時にアプリ本来のバインディングが戻ります。`fromApp()` を呼ぶテストファイルは、すべて同じアプリのインスタンスを共有します。`beforeAll` でバインドしたまま戻さないフェイクは、後に実行されるファイルにも残ります。バインドは `fromApp()` がアプリを起動した後に行ってください。プロバイダは起動中に本物のサービスを組み立てますが、フェイクのイベントマネージャーは `EventManager` のすべてを備えてはいません。

フェイクをマネージャーに包まずに直接バインドすると、最初に使われたところで失敗し、リクエストは 500 を返します。

| 直接バインドしたもの | エラー |
|---|---|
| `events` に `fakeEvent()` | `this.make("events").emit is not a function` |
| `mail` に `fakeMail()` | `manager.getDefaultFrom is not a function` |
| `queue` に `fakeQueue()` | `manager.getDefaultDriverName is not a function` |

`setQueueDriver(fakeQueue().getDriver())` でも `Job.dispatch()` を横取りできますが、2.23.0 で非推奨になり、3.0.0 で削除されます。

### 使えるアサーション

`FakeMail` が記録するのは組み立て済みのメッセージで、それを作った `Mail` クラスは記録しません。アサーションが見るのは宛先、件名、本文です。

**FakeMail:**

| メソッド | 説明 |
|--------|-------------|
| `assertSent(callback?)` | メールが送信された。callback を渡すと、いずれかがそれに一致する |
| `assertSentTimes(count)` | 送信されたメールが全部でちょうど `count` 通 |
| `assertNothingSent()` | メールが 1 通も送信されていない |
| `assertSentTo(email)` | そのアドレス宛てにメールが送信された |
| `assertSentFrom(email)` | そのアドレスからメールが送信された |
| `assertSentWithSubject(subject)` | 件名がこの文字列と完全に一致するメールがある |
| `assertSentWithBodyContaining(text)` | テキストか HTML の本文に `text` を含むメールがある |
| `assertSentWithCc(email)`、`assertSentWithBcc(email)` | そのアドレスを CC または BCC に含むメールがある |
| `assertSentWithAttachment(filename)` | このファイル名の添付を持つメールがある |
| `sent()`、`sentTo(email)` | 記録されたメール。すべて、または 1 つのアドレス宛てのもの |

**FakeEvent:**

| メソッド | 説明 |
|--------|-------------|
| `assertDispatched(event, callback?)` | イベントがディスパッチされた。callback を渡すと、いずれかのインスタンスが一致する |
| `assertDispatchedTimes(event, count)` | イベントがちょうど `count` 回ディスパッチされた |
| `assertDispatchedWith(event, data)` | `data` のプロパティをすべて `===` で満たすインスタンスがある |
| `assertDispatchedInOrder(events)` | この順序でディスパッチされた。間に別のイベントが入ってもよい |
| `assertNotDispatched(event)` | イベントがディスパッチされていない |
| `assertNothingDispatched()` | イベントが 1 つもディスパッチされていない |
| `dispatched(event)` | 記録されたそのイベントのインスタンス |

**FakeQueue:**

| メソッド | 説明 |
|--------|-------------|
| `assertPushed(job, callback?)` | ジョブが積まれた。callback を渡すと、いずれかのペイロードが一致する |
| `assertPushedTimes(job, count)` | ジョブがちょうど `count` 回積まれた |
| `assertPushedOn(queue, job)` | ジョブが指定した名前のキューに積まれた |
| `assertPushedWithDelay(job, delay)` | ジョブがこの遅延（ミリ秒）で積まれた |
| `assertNotPushed(job)` | ジョブが積まれていない |
| `assertNothingPushed()` | ジョブが 1 つも積まれていない |
| `pushed(job)` | 記録されたそのジョブの積み込み |

3 つとも `clear()` を持っています。複数のテストで同じフェイクを使い回すときに記録を消せます。

### テストデータベースの分離

`bun test` は `NODE_ENV=test` を自動的に設定します。新規にスキャフォールドされたプロジェクトの `config/database.ts` はこれを利用して、テストが開発用データベースにまったく触れないようにしています。

```ts
// config/database.ts
const database = createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  filename: (context) => {
    const values = context?.env ?? env.parse(undefined, { mode: 'report' }).values
    return process.env.NODE_ENV === 'test'
      ? values.TEST_DATABASE_URL ?? './data/guren.test.db'
      : values.DATABASE_URL ?? './data/guren.db'
  },
})
```

テストはデフォルトで `./data/guren.db` とは別ファイルの `./data/guren.test.db` を読み書きします。そのため、テストが作成したデータが開発サーバーで見ているデータに混ざることはありません。テスト用ファイル自体は `TEST_DATABASE_URL` で上書きできます(例: 並列実行する CI シャードごとに別ファイルを割り当てる場合)。それ以外の環境では引き続き `DATABASE_URL` が優先されます。どちらのキーもスキャフォールドの `config/env.ts` に宣言済みで、アプリの起動時には検証済みの値が `context` で渡されます([設定](./configuration.md#データベース接続)を参照)。

> [!WARNING]
> このブランチが導入される前にスキャフォールドされたプロジェクトは、`NODE_ENV` に関係なく `DATABASE_URL`(または `./data/guren.db`)へ直接書き込みます。そのため `bun test` が開発サーバーと同じデータベースを汚染してしまいます。後付けする際は `filename` オプションを差し替え、`DATABASE_URL` と `TEST_DATABASE_URL` を `config/env.ts` に宣言してください。このファイルがないアプリは先に追加します([設定](./configuration.md#サービスプロバイダを使うアプリ)を参照):
>
> ```diff
> +import env from './env.js'
> +
>  const database = createSqliteDatabase({
>    migrationsFolder: new URL('../db/migrations', import.meta.url),
>    seedersFolder: new URL('../db/seeders', import.meta.url),
> -  filename: () => process.env.DATABASE_URL || './data/guren.db',
> +  filename: (context) => {
> +    const values = context?.env ?? env.parse(undefined, { mode: 'report' }).values
> +    return process.env.NODE_ENV === 'test'
> +      ? values.TEST_DATABASE_URL ?? './data/guren.test.db'
> +      : values.DATABASE_URL ?? './data/guren.db'
> +  },
>  })
> ```

### データのクリーンアップ

ほとんどのスイートでは、テスト専用ファイルによる分離だけで十分です。`config/database.ts` がすでにエクスポートしている `resetDatabase()` を `beforeEach` で使い、クリーンな状態にリセットしましょう。この関数はすべてのテーブルを削除したあとマイグレーションを再適用します（`guren db:reset` と同じ最終状態）。そのため、リセット直後からテーブルをそのままクエリできます。

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { resetDatabase } from '@/config/database'

describe('User モデル', () => {
  beforeEach(async () => {
    await resetDatabase() // 全テーブルを削除してマイグレーションを再適用
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

Guren の SQLite アダプターは、この `DatabaseConnection` をそのままは提供しません。`config/database.ts` の `getDatabase()` が解決するのは内部の Drizzle インスタンスで、このインターフェースとは形が異なります。そのため、これらのヘルパーを使うにはアダプターを自分で書き、テスト実行前に `setTestDatabase()` へ渡す必要があります。**同一の接続でなければならない**という制約があるのは `useDatabaseTransactions()` だけです。`beforeEach` でトランザクションを開始し `afterEach` でロールバックするため、同じファイルへ独立に開いた 2 本目の接続からは、1 本目の接続で行った書き込みが見えず、ロールバックもされません。`useTruncateTables()` にこの制約はありません。`DELETE FROM` は即座にコミットされる操作なので、同じデータベースファイルへの接続であればどれを使ってもモデル側から見える行を削除できます。アダプターの配線が大げさだと感じる場合は、上記の `resetDatabase()` パターンの方がシンプルで、この問題自体を避けられます。

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

1. **ほとんどのテストには TestApp を使う** - ミドルウェアとルーティング一式を含む、最もリアルなテスト環境になります。
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

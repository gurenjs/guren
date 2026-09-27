# テストガイド

よく書けたテストが 1 つあれば、ユーザーより先にバグを見つけられます。Guren は、ブラウザで手作業で確かめるよりテストを書くほうが速いと感じられることを目指しています。

## TestApp

`TestApp` は、アプリケーションの HTTP 層をテストするための API です。ミドルウェアとルーティングをひととおり備えた軽量なアプリケーションのインスタンスを起動し、そこにリクエストを送って、レスポンスをメソッドチェーンでアサートできます。

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

`TestApp.create({ ... })` は、渡した部品からアプリを組み立てます。一部分だけを切り出したテストには便利ですが、組み立てた構成は、サーバーが実際に動かす構成(プロバイダー、`auth`、`i18n`、セキュリティの既定値)から知らないうちに離れていきます。実際の構成で確かめたいテストでは、プロジェクトが export しているアプリをラップしてください。

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

`fromApp()` は、アプリの boot と fetch ハンドラの束縛をまとめて行います。同じインスタンスに対して、複数のテストファイルから呼んでも構いません。`boot()` は何度呼んでも結果が変わらず、最初の boot をそのまま使います。

同じことを手で書くと、次のような長い形になります。ここでアロー関数を使っている点に注意してください。`fetch` はインスタンスの状態を読むので、束縛していない `app.fetch` をそのまま `fromFetch` に渡すと、最初のリクエストで例外になります。`fromApp()` は、この落とし穴をなくすために用意されています。`fromFetch` を使うのは、手元にあるのが Guren アプリケーションではなく任意の fetch 関数の場合です。

```ts
await app.boot()
http = TestApp.fromFetch((request) => app.fetch(request))
```

部品から組み立てる場合、`TestApp.create()` は `createApp` と同じオプションを受け取ります。セッションと CSRF のミドルウェアが必要なら `auth` を、テストするコントローラーが `this.t()` / `this.tc()` を使うなら `i18n` を渡してください。

```ts
const app = await TestApp.create({
  routes: registerWebRoutes,
  i18n: { supported: ['en'] },
})
```

`process.env` を書き換えずに環境変数を 1 つだけ変えて試したいときは、`config/env.ts` のスキーマを `env` に、上書きする値を `envSource` に渡します。`envSource` は `process.env` より先に読まれ、`''` を渡した変数は未設定として扱われます。`create()` は `config` 配列を受け取らないので、上書きした値が届くのは、プロバイダーやコントローラーが `this.make('env')` で読む値だけです。不正な値を渡すと、`create()` が返す Promise は `EnvValidationError` で reject されます。

```ts
import { TestApp } from '@guren/testing'
import env from '../config/env.js'

const app = await TestApp.create({
  env,
  envSource: { CACHE_STORE: 'memory', APP_URL: '' },
  providers: [ReportProvider],
})
```

`TestApp.fromApp(app)` は、`src/app.ts` が `createApp()` に渡しているスキーマと config 定義で起動するので、機能テストも本番と同じ設定で動きます。詳しくは[設定](./configuration.md#テスト)を参照してください。

### リクエストの送信

TestApp では、標準的な HTTP メソッドをすべて使えます。

```ts
await app.get('/posts')
await app.post('/posts', body)
await app.put('/posts/1', body)
await app.patch('/posts/1', body)
await app.delete('/posts/1')
await app.query('/posts/search', body) // HTTP QUERY (RFC 10008)
```

### Fluent アサーション

リクエストの後ろに、レスポンスのアサーションをそのままつなげて書けます。

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

ログイン済みのユーザーとしてリクエストを送るには、`actingAs()` を使います。

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

パスワードを扱うテストを速くするための設定は要りません。`TestApp` が `GUREN_TESTING=1` を設定し、この変数がある間は既定のハッシャーが軽いパラメータを使います(scrypt なら N=1024、`hasher: 'argon2'` の Argon2id なら 1 MiB・1 反復)。本番の強さのハッシュは 1 回に 100ms 以上かかるので、次のようなテストでは実行時間のほとんどがハッシュに使われてしまいます。

```ts
const user = await User.create({ email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' })
await app.post('/login', { email: 'ada@example.com', password: 'correct horse battery' }).assertRedirect('/')
```

それでも、ログインのテストでは本物のハッシュが検証されます。検証のときはハッシュに埋め込まれたパラメータを読むので、テストでは軽いハッシュを、本番では本番のハッシュを、同じように検証できます。テストの外では `Hash.needsRehash()` が軽いハッシュを古いものと判定します。そのため、テストモードのプロセスが書き込んだ行も、[暗号化ガイド](./encryption.md)にあるログイン時の再ハッシュ(rehash-on-login)で本番の強さに置き換わります。デプロイしたアプリでこの変数が設定されることはありません。

### カスタムリクエストヘッダー

`withHeaders()` / `withHeader()` を使うと、すべてのリクエストにヘッダーを付けられます。
ロケールの判定、API のバージョン指定、Bearer トークンなどに便利です。
`actingAs()` や `json()` と同じく新しい `TestApp` を返すので、自由に組み合わせられます。

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

`@guren/testing` パッケージには、コントローラーのテストに使うヘルパーがあります。

- `createControllerContext(url, init?)`: コントローラー用の Hono コンテキストを作ります。
- `createGurenControllerModule()`: Vitest の実行時に `guren` パッケージをモックし、コントローラーを切り離してテストできるようにします。
- `createControllerModuleMock()`: `vi.mock('@guren/core', …)` に渡すモックです。この `Controller` はフレームワーク本体の `Controller` を継承していて、起動済みのアプリを必要とする `inertia()` と `make()` の解決先だけを差し替えます。
- `readInertiaResponse(response)`: Inertia のレスポンスを `{ format, payload, body }` の形にそろえ、アサーションを書きやすくします。

これらを Vitest のスイート（例: `examples/blog/tests`）で import すれば、Bun 固有の API を使わずに React/Inertia のコントローラーのテストを書けます。

### トラブルシューティング

- `vi.mock is not a function` が出る場合は、そのテストが Bun で実行されています。上の Vitest のコマンドで実行してください。
- `ReferenceError: document is not defined` が出るのは、DOM に依存するテストが jsdom の外で実行されているときです。Vitest のランナーを使うか、jsdom を明示的に設定してください。
- jsdom 環境では、`FormData` に入れて送った `File` がアクションに届きません。`this.file()` を呼ぶアクションを `createControllerContext(url, { method: 'POST', body: formData })` でテストすると起きます。jsdom はグローバルの `File` と `Blob` を独自のクラスに置き換えるので、undici が multipart のボディの組み立てと解析に使うクラスと一致しなくなるためです。Vitest と Node のバージョンによって、テストがタイムアウトするか、undici の内部で失敗するか、`this.file()` が `null` を返してアップロードが消えたままテストが通ってしまいます。コントローラーのテストは DOM を描画しないので、ファイルの先頭行に次のコメントを書いて Node 環境で実行してください。

  ```ts
  // @vitest-environment node
  import { describe, expect, it } from 'vitest'
  ```

ランナーを分けておくと、フレームワークのコードでは Bun の速いフィードバックが得られ、SPA のテストでは実際に近い DOM の動きで確かめられます。

## サービスのフェイク

テストの中で本物のメールを送ったり、本物のイベントをディスパッチしたり、キューにジョブを積んだりするのは避けます。`@guren/testing` には、それぞれのフェイクとして `fakeEvent()`、`fakeMail()`、`fakeQueue()` があります。フェイクが必要なテストの中で、プロジェクトが export しているアプリに `app.container.fake()` でバインドしてください。

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

コンテナの各キーに入っているのはマネージャーです（`events` は `EventManager`、`mail` は `MailManager`、`queue` は `QueueManager`）。フェイクはその 1 段下の部品なので、マネージャーに包んでからバインドします。

- `fakeEvent()` は、内部に持っているマネージャーを通して記録します。バインドするのは `events.getManager()` です。このマネージャーにはリスナーが登録されないので、リスナーは実行されず、リスナーが始めるはずのジョブやメールも動きません。
- `fakeMail()` はトランスポートです。本物の `MailManager` に登録し、そのマネージャーをバインドします。
- `fakeQueue()` はドライバーです。`createQueueManager()` のファクトリーから返し、そのマネージャーをバインドします。

`assertPushed` には、ペイロードの型を明示して渡してください。ジョブクラスだけではペイロードの型が TypeScript に伝わらず、述語の引数が `unknown` になります。

`fake()` は破棄できるオブジェクト（disposable）を返すので、`using` で受け取っておけば、テストの終わりにアプリ本来のバインディングに戻ります。`fromApp()` を呼ぶテストファイルは、どれも同じアプリのインスタンスを共有します。`beforeAll` でバインドしたまま戻さないフェイクは、後から実行されるファイルにも残ってしまいます。バインドは、`fromApp()` がアプリを起動した後で行ってください。プロバイダは起動中に本物のサービスを組み立てますが、フェイクのイベントマネージャーは `EventManager` の機能をすべて備えているわけではないからです。

フェイクをマネージャーに包まずに直接バインドすると、最初に使われたところで失敗し、リクエストは 500 を返します。

| 直接バインドしたもの | エラー |
|---|---|
| `events` に `fakeEvent()` | `this.make("events").emit is not a function` |
| `mail` に `fakeMail()` | `manager.getDefaultFrom is not a function` |
| `queue` に `fakeQueue()` | `manager.getDefaultDriverName is not a function` |

`setQueueDriver(fakeQueue().getDriver())` でも `Job.dispatch()` を横取りできますが、この方法は 2.23.0 で非推奨になり、3.0.0 で削除されます。

### 使えるアサーション

`FakeMail` が記録するのは組み立て済みのメッセージで、それを作った `Mail` クラスは記録しません。アサーションで確かめられるのは、宛先、件名、本文です。

**FakeMail:**

| メソッド | 説明 |
|--------|-------------|
| `assertSent(callback?)` | メールが送信された。callback を渡した場合は、送信されたどれかがそれに一致する |
| `assertSentTimes(count)` | 送信されたメールが全部でちょうど `count` 通ある |
| `assertNothingSent()` | メールが 1 通も送信されていない |
| `assertSentTo(email)` | そのアドレス宛てにメールが送信された |
| `assertSentFrom(email)` | そのアドレスからメールが送信された |
| `assertSentWithSubject(subject)` | 件名がこの文字列と完全に一致するメールがある |
| `assertSentWithBodyContaining(text)` | テキストか HTML の本文に `text` を含むメールがある |
| `assertSentWithCc(email)`、`assertSentWithBcc(email)` | そのアドレスを CC または BCC に含むメールがある |
| `assertSentWithAttachment(filename)` | このファイル名の添付を持つメールがある |
| `sent()`、`sentTo(email)` | 記録されたメールを返す。すべて、または 1 つのアドレス宛てのもの |

**FakeEvent:**

| メソッド | 説明 |
|--------|-------------|
| `assertDispatched(event, callback?)` | イベントがディスパッチされた。callback を渡した場合は、どれかのインスタンスがそれに一致する |
| `assertDispatchedTimes(event, count)` | イベントがちょうど `count` 回ディスパッチされた |
| `assertDispatchedWith(event, data)` | `data` のプロパティをすべて `===` で満たすインスタンスがある |
| `assertDispatchedInOrder(events)` | この順にディスパッチされた。間に別のイベントが入ってもよい |
| `assertNotDispatched(event)` | イベントがディスパッチされていない |
| `assertNothingDispatched()` | イベントが 1 つもディスパッチされていない |
| `dispatched(event)` | 記録されたそのイベントのインスタンスを返す |

**FakeQueue:**

| メソッド | 説明 |
|--------|-------------|
| `assertPushed(job, callback?)` | ジョブが積まれた。callback を渡した場合は、どれかのペイロードがそれに一致する |
| `assertPushedTimes(job, count)` | ジョブがちょうど `count` 回積まれた |
| `assertPushedOn(queue, job)` | ジョブが指定した名前のキューに積まれた |
| `assertPushedWithDelay(job, delay)` | ジョブがこの遅延（ミリ秒）で積まれた |
| `assertNotPushed(job)` | ジョブが積まれていない |
| `assertNothingPushed()` | ジョブが 1 つも積まれていない |
| `pushed(job)` | 記録されたそのジョブの積み込みを返す |

3 つとも `clear()` を持っているので、複数のテストで同じフェイクを使い回すときは記録を消せます。

### テストデータベースの分離

`bun test` は `NODE_ENV=test` を自動で設定します。新しく生成したプロジェクトの `config/database.ts` はこれを使い、テストが開発用のデータベースに一切触れないようにしています。

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

テストは既定で、`./data/guren.db` とは別のファイル `./data/guren.test.db` を読み書きします。そのため、テストで作ったデータが、開発サーバーで見ているデータに混ざることはありません。テスト用のファイルは `TEST_DATABASE_URL` で変えられます(たとえば、並列で走らせる CI のシャードごとに別のファイルを割り当てる場合)。テスト以外の環境では、これまでどおり `DATABASE_URL` が使われます。どちらのキーも雛形の `config/env.ts` に宣言してあり、アプリの起動時には検証済みの値が `context` で渡されます([設定](./configuration.md#データベース接続)を参照)。

> [!WARNING]
> この `NODE_ENV` による分岐が入る前に生成したプロジェクトは、`NODE_ENV` に関係なく `DATABASE_URL`(または `./data/guren.db`)に直接書き込みます。そのため、`bun test` が開発サーバーと同じデータベースを汚してしまいます。あとから対応するには、`filename` オプションを差し替え、`DATABASE_URL` と `TEST_DATABASE_URL` を `config/env.ts` に宣言してください。このファイルがないアプリでは、先に追加します([設定](./configuration.md#サービスプロバイダを使うアプリ)を参照)。
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

ほとんどのスイートは、テスト専用のファイルで分けるだけで十分です。テストごとにきれいな状態に戻すには、`config/database.ts` がすでに export している `resetDatabase()` を `beforeEach` で呼んでください。この関数はすべてのテーブルを削除してからマイグレーションを適用し直すので（最終的な状態は `guren db:reset` と同じ）、リセットした直後からテーブルにそのままクエリできます。

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

テストごとにもっと細かく後片付けしたい場合のために、`@guren/testing` には `useTruncateTables(tables)` と `useDatabaseTransactions()` もあります。`useTruncateTables()` は、各テーブルの行を削除する `beforeEach` フックだけを登録します。`useDatabaseTransactions()` は、トランザクションを始めてテストの後にロールバックする `beforeEach`/`afterEach` フックを登録します。どちらも、あらかじめ `setTestDatabase()` で登録した、次の形の接続に対して動きます。

```typescript
interface DatabaseConnection {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<void>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}
```

Guren の SQLite アダプターは、この `DatabaseConnection` をそのままの形では渡してくれません。`config/database.ts` の `getDatabase()` が返すのは内部の Drizzle インスタンスで、このインターフェースとは形が違います。そのため、これらのヘルパーを使うには小さなアダプターを自分で書き、テストを実行する前に `setTestDatabase()` に渡す必要があります。`useDatabaseTransactions()` だけは、**モデルが書き込むのと同じ接続を包む**必要があります。`beforeEach` でトランザクションを始めて `afterEach` でロールバックするので、同じファイルに別に開いた 2 本目の接続からは、1 本目の接続での書き込みが見えず、ロールバックもされないからです。`useTruncateTables()` にはこの制約はありません。`DELETE FROM` はその場でコミットされるので、同じデータベースファイルへの接続ならどれを使っても、モデルから見える行を削除できます。アダプターを用意するのが大げさに感じるなら、上の `resetDatabase()` のやり方のほうが簡単で、この問題にもそもそも悩まずに済みます。

### HTTP テスト

HTTP エンドポイントのテストには、TestApp（推奨）か、低レベルのコントローラーテスト用ヘルパーを使います。

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

コントローラー単体の低レベルなテストには、これまでどおり `createControllerContext` も使えます。

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

1. **ほとんどのテストには TestApp を使う**: ミドルウェアとルーティングをひととおり含むので、いちばん本番に近い環境でテストできます。
2. **beforeEach でフェイクをリセットする**: 毎回きれいな状態から始めます。
3. **具体的なアサーションを使う**: できるだけ `assertSent` より `assertSentWith` を使います。
4. **失敗するケースもテストする**: エラーになる場面で、イベントやメールが送られないことを確かめます。
5. **テストを互いに切り離す**: どのテストも、ほかのテストに依存しないようにします。
6. **認証には `actingAs()` を使う**: テストの中でセッションのデータを手で設定するのは避けます。
7. **コンテナのフェイクを使う**: import をモックするのではなく、`container.fake()` でサービスを置き換えます。

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
> サーバー側のコードは、Bun 標準のテストランナー（`bun:test`）でテストします。フロントエンドや React コンポーネントは、jsdom を使う Vitest でテストします。ランナーを使い分けているのは、フレームワークのコードでは Bun の速いフィードバックを、SPA のテストでは実際に近い DOM の動きを得るためです。

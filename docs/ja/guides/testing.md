# テストガイド

`TestApp` を使うと、アプリを HTTP 越しにテストできます。本物のミドルウェアとルートを通してリクエストを送り、レスポンスをアサートします。このページでは、ユーザーとしてログインした状態でのテスト、開発用データベースとの切り分け、メール・イベント・キューのフェイクも扱います。

生成したアプリは Bun のテストランナーでテストを実行し、例として `tests/HomeController.test.ts` が 1 つ入っています。スイートは `bun run test` で実行します（[テストの実行](#テストの実行)を参照）。

## TestApp

`TestApp` はアプリケーションを同じプロセスの中で起動します。ミドルウェアとルーティングはすべて本物のまま動き、リクエストごとにアサーションをメソッドチェーンで書けます。生成したアプリのテストも、`src/app.ts` が export するアプリをこの方法でラップしています。

```ts
import { beforeAll, describe, test } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

describe('Posts', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  test('lists all posts', async () => {
    await http.get('/posts').assertOk()
  })

  test('returns 404 for a missing post', async () => {
    await http.get('/posts/999').assertNotFound()
  })
})
```

標準的な HTTP メソッドはすべて使えます。

```ts
await app.get('/posts')
await app.post('/posts', body)
await app.put('/posts/1', body)
await app.patch('/posts/1', body)
await app.delete('/posts/1')
await app.query('/posts/search', body) // HTTP QUERY (RFC 10008)
```

### アプリの組み立て方を選ぶ

| 組み立て方 | 動かすもの | 使う場面 |
|------------|------------|----------|
| `TestApp.fromApp(app)` | `src/app.ts` が export するアプリ。プロバイダー、`auth`、`i18n`、設定もそのまま | ほとんどのテスト。本番と同じ構成で確かめられる |
| `TestApp.create({ ... })` | 渡したオプションから組み立てたアプリ | 一部分だけを切り出して試すとき、環境変数を上書きして試すとき |
| `TestApp.fromFetch(fetch)` | 任意の fetch 関数 | ハンドラーが Guren アプリケーションではないとき |

### 実アプリをラップする

`fromApp()` は、アプリの boot と fetch ハンドラーの束縛をまとめて行います。同じインスタンスに対して、複数のテストファイルから呼んでも構いません。`boot()` は 1 回だけ実行され、2 回目以降は最初の boot をそのまま使います。起動には、`src/app.ts` が `createApp()` に渡している環境変数のスキーマと config 定義が使われます（詳しくは[設定](./configuration.md#テスト)を参照）。

同じことを手で書いた、次のような長い形を見かけることもあります。

```ts
await app.boot()
http = TestApp.fromFetch((request) => app.fetch(request))
```

この形で書くときは、アロー関数のままにしてください。`fetch` はインスタンスの状態を読むので、束縛していない `app.fetch` をそのまま `fromFetch` に渡すと、最初のリクエストで例外になります。

### 部品からアプリを組み立てる

`TestApp.create()` は `createApp` と同じオプションを受け取ります。一部分だけで組み立てた構成は、サーバーが実際に動かす構成から離れていきがちです。テストするコードが必要とするものは渡してください。セッションと CSRF のミドルウェアが必要なら `auth` を、コントローラーが `this.t()` / `this.tc()` を呼ぶなら `i18n` を渡します。

```ts
const app = await TestApp.create({
  routes: registerWebRoutes,
  i18n: { supported: ['en'] },
})
```

`process.env` を書き換えずに環境変数を 1 つだけ変えて試したいときは、`config/env.ts` のスキーマを `env` に、上書きする値を `envSource` に渡します。

```ts
import { TestApp } from '@guren/testing'
import env from '../config/env.js'

const app = await TestApp.create({
  env,
  envSource: { CACHE_STORE: 'memory', APP_URL: '' },
  providers: [ReportProvider],
})
```

- `envSource` は `process.env` より先に読まれます。`''` を渡した変数は未設定として扱われます。
- 上書きした値が届くのは、プロバイダーやコントローラーが `this.make('env')` で読む値です。`create()` は `config` 配列を受け取りません。
- 不正な値を渡すと、`create()` が返す Promise は `EnvValidationError` で reject されます。

### Fluent アサーション

リクエストの後ろに、レスポンスのアサーションをそのままつなげて書けます。

```ts
// ステータス
await app.get('/posts').assertOk()                         // 200
await app.get('/posts').assertStatus(200)
await app.post('/posts', data).assertStatus(201)
await app.delete('/posts/1').assertNoContent()              // 204
await app.get('/secret').assertUnauthorized()                // 401
await app.get('/secret').assertForbidden()                   // 403
await app.get('/missing').assertNotFound()                   // 404

// JSON
await app.get('/posts').assertJson({ data: [] })
await app.get('/posts').assertJsonCount(5, 'data')
await app.get('/posts/1').assertJsonPath('post.title', 'Hello')
await app.get('/posts').assertJsonStructure(['data', 'meta'])

// ヘッダーとリダイレクト
await app.get('/posts').assertHeader('content-type', 'application/json')
await app.get('/old-page').assertRedirect('/new-page')
```

## テストでの認証

ログインの手順を通さずに、あるユーザーとしてリクエストを送るには `actingAs()` を使います。

```ts
import { User } from '@/app/Models/User'

const user = await User.create({
  email: 'test@example.com',
  name: 'Test User',
})

// ログイン済みとしてリクエストを送る
await app.actingAs(user).get('/dashboard').assertOk()
await app.actingAs(user).post('/posts', data).assertStatus(201)

// ログインしていなければ、保護されたルートは拒否する
await app.get('/dashboard').assertUnauthorized()
```

### テストでのパスワードハッシュ

パスワードを扱うテストは、何も設定しなくても速く動きます。`TestApp` が `GUREN_TESTING=1` を設定し、この変数がある間は既定のハッシャーが軽いパラメータを使うからです（scrypt なら N=1024、`hasher: 'argon2'` の Argon2id なら 1 MiB・1 反復）。本番の強さのハッシュは 1 回に 100ms 以上かかるので、次のようなテストでは実行時間のほとんどがハッシュに使われてしまいます。

```ts
const user = await User.create({ email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' })
await app.post('/login', { email: 'ada@example.com', password: 'correct horse battery' }).assertRedirect('/')
```

それでも、ログインのテストでは本物のハッシュが検証されます。検証のときはハッシュに埋め込まれたパラメータを読むからです。軽いハッシュが本番に残ることもありません。テストの外では `Hash.needsRehash()` が軽いハッシュを古いものと判定し、[暗号化ガイド](./encryption.md)にあるログイン時の再ハッシュで本番の強さに置き換わります。デプロイしたアプリでこの変数が設定されることはありません。

## JSON API のテスト

API エンドポイントには `.json()` を使います。JSON のヘッダーを付けて送るので、バリデーションエラーも含めてアプリは JSON で応答します。

```ts
test('API returns paginated posts', async () => {
  await app.json().get('/api/posts')
    .assertOk()
    .assertJsonStructure(['data', 'meta'])
    .assertJsonCount(10, 'data')
    .assertJsonPath('meta.currentPage', 1)
})

test('API validates input', async () => {
  await app.json().post('/api/posts', { title: '' })
    .assertStatus(422)
    .assertJsonPath('errors.title.0', 'Too small: expected string to have >=1 characters')
})
```

エラーの本文の形は[バリデーション](./validation.md#フォームバリデーションエラー)を参照してください。

## カスタムリクエストヘッダー

`withHeaders()` / `withHeader()` を使うと、すべてのリクエストにヘッダーを付けられます。ロケール、API のバージョン、Bearer トークンなどに使います。`actingAs()` や `json()` と同じく新しい `TestApp` を返すので、組み合わせて使えます。

```ts
test('renders the English locale', async () => {
  const en = app.withHeaders({ 'Accept-Language': 'en' })
  await en.get('/').assertOk()
})

test('accepts an API token', async () => {
  await app
    .withHeader('Authorization', `Bearer ${token}`)
    .json()
    .get('/api/me/tasks')
    .assertOk()
})
```

## テストでのデータベース

### テストデータベースの分離

`bun test` は `NODE_ENV=test` を設定します。生成したアプリの `config/database.ts` はこれを見て、テストのときだけ別の SQLite ファイルを使います。

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

| 環境 | データベースのファイル | 変更に使う環境変数 |
|------|------------------------|--------------------|
| `bun test` | `./data/guren.test.db` | `TEST_DATABASE_URL`（たとえば並列で走らせる CI のシャードごとに別のファイルを割り当てる） |
| それ以外 | `./data/guren.db` | `DATABASE_URL` |

テストで作ったデータが、開発サーバーで見ているデータに混ざることはありません。どちらのキーも雛形の `config/env.ts` に宣言してあり、アプリの起動時には検証済みの値が `context` で渡されます（[設定](./configuration.md#データベース接続)を参照）。

> [!WARNING]
> `create-guren-app` 1.1.0 以前で生成したアプリは、`NODE_ENV` に関係なく `DATABASE_URL`（または `./data/guren.db`）に書き込みます。そのため、`bun test` が開発サーバーと同じデータベースに書き込んでしまいます。直すには、`filename` オプションを差し替え、`DATABASE_URL` と `TEST_DATABASE_URL` を `config/env.ts` に宣言してください。このファイルがないアプリでは、先に追加します（[設定](./configuration.md#サービスプロバイダを使うアプリ)を参照）。
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

### テスト間のクリーンアップ

テストごとに空のデータベースから始めるには、`config/database.ts` がすでに export している `resetDatabase()` を `beforeEach` で呼びます。この関数はすべてのテーブルを削除してからマイグレーションを適用し直し、`guren db:reset` と同じ状態にするので、直後からテーブルにクエリできます。

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { resetDatabase } from '@/config/database'

describe('User Model', () => {
  beforeEach(async () => {
    await resetDatabase() // 全テーブルを削除してマイグレーションを再適用
  })

  test('creates a user', async () => {
    const user = await User.create({
      email: 'test@example.com',
      name: 'Test User',
    })

    expect(user.id).toBeDefined()
    expect(user.email).toBe('test@example.com')
  })
})
```

### テストごとの後片付けヘルパー

`@guren/testing` には、もっと細かく後片付けするためのヘルパーも 2 つあります。たいていのスイートには必要なく、`resetDatabase()` のほうが簡単です。

| ヘルパー | 登録するフック |
|----------|----------------|
| `useTruncateTables(tables)` | 指定した各テーブルの行をすべて削除する `beforeEach` |
| `useDatabaseTransactions()` | トランザクションを始め、テストの後でロールバックする `beforeEach` / `afterEach` |

どちらも、先に `setTestDatabase()` で登録した次の形の接続に対して動きます。

```ts
interface DatabaseConnection {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<void>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}
```

この接続を書く前に、次の点を押さえておいてください。

- Guren はこの接続を用意しません。`config/database.ts` の `getDatabase()` が返すのは内部の Drizzle インスタンスなので、小さなアダプターを書いて、テストを実行する前に `setTestDatabase()` に渡します。
- `useDatabaseTransactions()` には、**モデルが書き込むのと同じ接続**を渡す必要があります。同じファイルに別に開いた 2 本目の接続からは、1 本目の書き込みが見えず、ロールバックもされません。
- `useTruncateTables()` は、同じデータベースへの接続ならどれを通しても動きます。`DELETE FROM` はその場でコミットされるからです。
- テーブルは渡した順に空にします。外部キーを検査する接続（Postgres と MySQL のすべての接続と、`getDatabase()` が返す SQLite の接続）では、外部キーが cascade でない限り、子テーブルを親より先に並べてください。

## サービスのフェイク

テストの中で本物のメールを送ったり、本物のリスナーを動かしたり、本物のジョブを積んだりするのは避けます。`@guren/testing` には、それぞれのフェイクとして `fakeEvent()`、`fakeMail()`、`fakeQueue()` があります。フェイクが必要なテストの中で、プロジェクトが export しているアプリに `app.container.fake()` でバインドしてください。

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

`http.withCsrf()` は `/` を一度取得し、以降のすべてのリクエストでセッションの Cookie と CSRF トークンを送る `TestApp` を返します。これで、`POST` もブラウザーからの送信と同じように CSRF の保護を通ります。

### フェイクのバインド

コンテナの各キーに入っているのはマネージャーで、フェイクはその 1 段下の部品です。そのため、マネージャーに包んでからバインドします。

| キー | 入っているマネージャー | フェイクのバインド方法 |
|------|------------------------|------------------------|
| `events` | `EventManager` | `fakeEvent()` は内部のマネージャーを通して記録する。`events.getManager()` をバインドする |
| `mail` | `MailManager` | `fakeMail()` はトランスポート。本物の `MailManager` に登録し、そのマネージャーをバインドする |
| `queue` | `QueueManager` | `fakeQueue()` はドライバー。`createQueueManager()` のファクトリーから返し、そのマネージャーをバインドする |

イベントのフェイクをバインドしている間はリスナーが実行されず、リスナーが始めるはずのジョブやメールも動きません。

フェイクをマネージャーに包まずに直接バインドすると、最初に使われたところで失敗し、リクエストは 500 を返します。

| 直接バインドしたもの | エラー |
|---|---|
| `events` に `fakeEvent()` | `this.make("events").emit is not a function` |
| `mail` に `fakeMail()` | `manager.getDefaultFrom is not a function` |
| `queue` に `fakeQueue()` | `manager.getDefaultDriverName is not a function` |

バインドするタイミングには決まりが 2 つあります。

- **テストの中で `using` を使ってバインドします。** `fake()` は破棄できるオブジェクト（disposable）を返すので、`using` で受け取っておけば、テストの終わりにアプリ本来のバインディングに戻ります。`fromApp()` を呼ぶテストファイルはどれも同じアプリのインスタンスを共有するので、`beforeAll` でバインドしたまま戻さないフェイクは、後から実行されるファイルにも残ってしまいます。
- **`fromApp()` がアプリを起動した後でバインドします。** プロバイダーは起動中に本物のサービスを組み立てますが、フェイクのイベントマネージャーは `EventManager` の機能をすべて備えているわけではありません。

`assertPushed` には、ペイロードの型を明示して渡してください。ジョブクラスだけではペイロードの型が TypeScript に伝わらず、述語の引数が `unknown` になります。

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

## テストの実行

```bash
# スイート全体
bun run test

# 1 ファイルだけ
bun test tests/HomeController.test.ts

# テストファイルを生成
bunx guren make:test posts/PostController
```

`make:test` は `bun:test` のファイルを書き出します。アプリに `vitest.config.*` があるか `vitest` に依存している場合は Vitest のファイルになります。`--runner bun` か `--runner vitest` で明示的に選べます。

## アプリを使わずにコントローラーをテストする（Vitest）

コントローラーのテストは、たいてい `TestApp` で足ります。Vitest を追加して、モデルをモックしたうえでコントローラー単体をテストしたい場合は、`@guren/testing` の次のヘルパーを使います。

- `createControllerContext(url, init?)` は、コントローラーが読むリクエストのコンテキストを作ります。
- `createControllerModuleMock()` は `vi.mock('@guren/core', …)` に渡すモックです。この `Controller` はフレームワーク本体の `Controller` を継承していて、起動済みのアプリを必要とする `inertia()` と `make()` だけを差し替えます。
- `createGurenControllerModule()` は、このモックの元になるモジュールです。`Controller` だけが必要なテストで使います。
- `readInertiaResponse(response)` は、Inertia のレスポンスを `{ format, payload, body }` の形にそろえ、アサーションを書きやすくします。

この構成に特有の問題が 2 つあります。

- `vi.mock is not a function` が出たら、そのファイルを Bun が実行しています。Vitest のファイルは `bun test` ではなく `bunx vitest` で実行してください。
- `ReferenceError: document is not defined` が出たら、DOM を必要とするテストが jsdom の外で実行されています。そのファイルの環境を `jsdom` にしてください。

### jsdom でのファイルアップロード

Vitest の `jsdom` 環境では、`FormData` に入れて送った `File` がアクションに届きません。たとえば `this.file()` を呼ぶアクションを `createControllerContext(url, { method: 'POST', body: formData })` でテストすると起きます。jsdom はグローバルの `File` と `Blob` を独自のクラスに置き換えるので、undici が multipart のボディの組み立てと解析に使うクラスと一致しなくなります。Vitest と Node のバージョンによって、テストがタイムアウトするか、undici の内部で失敗するか、`this.file()` が `null` を返したままテストが通ってしまいます。コントローラーのテストは DOM を描画しないので、ファイルの先頭行に次のコメントを書いて Node 環境で実行してください。

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
```

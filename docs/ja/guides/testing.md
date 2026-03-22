# テストガイド

Guren には 2 つのスタイルの自動テストがあります。

- **フレームワークのユニット/統合テスト**: パッケージ内（例: `packages/core/tests`）に配置されており、Bun のネイティブな `bun test` ランナーで実行します。
- **サンプルアプリケーションのテスト**: ブログデモ（`examples/blog`）などは、Vitest と jsdom を使用して、ブラウザと同等の方法で React コンポーネントをレンダリングします。

ランナーの想定が異なるため、それぞれに合った方法で実行してください。

```bash
# フレームワークパッケージ - Bun のテストランナー
bun test packages/core/tests
bun test packages/orm/tests
bun test packages/core/tests
bun test packages/cli/tests
bun test packages/create-app/tests
bun test packages/inertia-client/tests

# テストユーティリティ - Vitest
bun run --cwd packages/testing test

# サンプルアプリ - Vitest + jsdom
bun run --cwd examples/blog test
bun run --cwd examples/api test
bun run --cwd web test
```

### フレームワークパッケージ向けの Bun テストを書く

フレームワークテストは `bun:test` の組み込みアサーションを利用します。完全なアプリケーションの起動なしに、ルーティングレジストリや HTTP ヘルパーなどの低レベルユーティリティを検証するのに役立ちます。

よく使うパターン:

- コントローラーをインスタンス化し、アクション呼び出し前にスタブした Hono コンテキストで `setContext(ctx)` を呼ぶ。
- 軽量なフェイク（例: インメモリ ORM アダプター）を使って成功パスと失敗パスをカバーする。
- コードを所有するパッケージ内でフォーカスしたユニットテストを書く。内側のループを速く保つため、高レベルのアプリケーションテストは控えめに。

スタートポイントが欲しい場合はジェネレーターを使いましょう。

```bash
# tests/ 配下に Bun スタイルのテストファイルを生成
bunx guren make:test server/http/request --runner bun

# SPA コード向けの Vitest スタイルのテストファイル
bunx guren make:test blog/pages/Login
```

このコマンドは `tests/` 以下にスキャフォールドファイルを書き出します（必要に応じてディレクトリも作成）。デフォルトは Vitest で、`--runner bun` で切り替えられます。

## TestApp

`TestApp` は、アプリケーションの HTTP レイヤーをテストするための高レベルで表現力豊かな API を提供します。ミドルウェアとルーティングスタック一式を備えた軽量なアプリケーションインスタンスを起動し、リクエストの送信と流暢なインターフェースによるレスポンスのアサーションが可能です。

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

### リクエストの送信

TestApp は標準的な HTTP メソッドをすべてサポートしています。

```ts
await app.get('/posts')
await app.post('/posts', body)
await app.put('/posts/1', body)
await app.patch('/posts/1', body)
await app.delete('/posts/1')
```

### 流暢なアサーション

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

### データベーステスト

実際のデータベースに影響を与えずにテストするために、データベースフェイクを使用します。

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { DatabaseFake, RefreshDatabase } from '@guren/testing'

describe('User モデル', () => {
  beforeEach(async () => {
    await RefreshDatabase.refresh()
  })

  afterEach(async () => {
    await RefreshDatabase.cleanup()
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

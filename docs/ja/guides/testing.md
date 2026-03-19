# テストガイド

Guren には 2 つのスタイルの自動テストがあります。

- **フレームワークのユニット/統合テスト**: `packages/server/tests` などパッケージ内にあり、Bun の `bun test` で実行。
- **サンプルアプリのテスト**: 例として `examples/blog` は Vitest + jsdom を使用し、ブラウザと同等の React レンダリングを行います。

ランナーの想定が異なるため、それぞれに合った方法で実行します:

```bash
# フレームワークパッケージ（Bun ランナー）
bun test packages/server/tests
bun test packages/orm/tests
bun test packages/core/tests
bun test packages/cli/tests
bun test packages/create-app/tests
bun test packages/inertia-client/tests

# テストユーティリティ（Vitest）
bun run --cwd packages/testing test

# サンプルアプリ（Vitest + jsdom）
bun run --cwd examples/blog test
bun run --cwd examples/api test
bun run --cwd web test
```

### フレームワーク向け Bun テストを書く

`bun:test` の組み込みアサーションを利用し、ルーティングレジストリや HTTP ヘルパーなど低レベルユーティリティを、アプリ全体を起動せず検証します。

パターン例:

- コントローラを生成し、アクション呼び出し前にスタブした Hono コンテキストを `setContext(ctx)` で渡す。
- 成功/失敗パスをカバーする軽量フェイク（インメモリ ORM アダプターなど）を使う。
- コードを持つパッケージ内で焦点の定まったユニットテストを書く。内側のループを速く保つため高レベルアプリテストは最小限に。

スタートポイントが欲しい場合は生成コマンドを使います:

```bash
# tests/ 配下に Bun スタイルのテストを生成
bunx guren make:test server/http/request --runner bun

# SPA コード向け Vitest スタイルのテスト
bunx guren make:test blog/pages/Login
```

デフォルトは Vitest で、`--runner bun` で切り替えます。

### `@guren/testing` でコントローラをテストする

`@guren/testing` にはコントローラ向けヘルパーが用意されています:

- `createControllerContext(url, init?)` — コントローラ用の Hono コンテキストを構築。
- `createGurenControllerModule()` — Vitest 実行時に `guren` パッケージをモックし、コントローラを単体でテスト可能に。
- `createControllerModuleMock()` — `@guren/server` の `Controller`/`json`/`redirect` を Vitest 用に配線したドロップインモック。
- `readInertiaResponse(response)` — Inertia レスポンスを `{ format, payload, body }` に正規化し、アサーションを簡単に。

これらを Vitest スイート（例: `examples/blog/tests`）に取り込み、React/Inertia コントローラテストを表現的にしつつ Bun 固有 API を避けられます。

### トラブルシュート

- `vi.mock is not a function` が出る場合、そのテストは Bun で動いています。上記の Vitest コマンドに切り替えてください。
- `ReferenceError: document is not defined` は DOM 依存のテストが jsdom 外で走っているサインです。Vitest ランナーを使うか jsdom を明示的に設定してください。

ランナーを分けることで、フレームワークコードには Bun 由来の高速フィードバックを、SPA には実ブラウザに近い DOM 挙動を両立できます。

## テスト用フェイク

`@guren/testing` パッケージはテスト用のサービスのフェイク実装を提供します。これにより、実際にメール送信、イベントディスパッチ、ジョブキューイングを行わずにコードをテストできます。

### FakeMail

実際にメールを送信せずにメール送信をテストします：

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
      subject: 'アプリへようこそ！',
    })
  })
})
```

#### FakeMailメソッド

| メソッド | 説明 |
|--------|-------------|
| `assertSent(mailable)` | メールが送信されたことをアサート |
| `assertSentTimes(mailable, count)` | メールが正確な回数送信されたことをアサート |
| `assertNotSent(mailable)` | メールが送信されなかったことをアサート |
| `assertNothingSent()` | メールが全く送信されなかったことをアサート |
| `assertSentTo(email)` | 指定アドレスにメールが送信されたことをアサート |
| `assertSentWith(mailable, data)` | 特定のデータでメールが送信されたことをアサート |
| `assertQueuedCount(count)` | キューに入れられたメールの数をアサート |
| `sent(mailable)` | 送信されたメールのインスタンスをすべて取得 |

### FakeQueue

ジョブを処理せずにジョブディスパッチをテストします：

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

#### FakeQueueメソッド

| メソッド | 説明 |
|--------|-------------|
| `assertPushed(job)` | ジョブがプッシュされたことをアサート |
| `assertPushedTimes(job, count)` | ジョブが正確な回数プッシュされたことをアサート |
| `assertPushedOn(queue, job)` | 特定のキューにジョブがプッシュされたことをアサート |
| `assertPushedWith(job, data)` | 特定のデータでジョブがプッシュされたことをアサート |
| `assertNotPushed(job)` | ジョブがプッシュされなかったことをアサート |
| `assertNothingPushed()` | ジョブが全くプッシュされなかったことをアサート |
| `pushed(job)` | プッシュされたジョブのインスタンスをすべて取得 |

### FakeEvent

リスナーをトリガーせずにイベントディスパッチをテストします：

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

#### FakeEventメソッド

| メソッド | 説明 |
|--------|-------------|
| `assertDispatched(event, callback?)` | イベントがディスパッチされたことをアサート |
| `assertDispatchedTimes(event, count)` | イベントが正確な回数ディスパッチされたことをアサート |
| `assertNotDispatched(event)` | イベントがディスパッチされなかったことをアサート |
| `assertNothingDispatched()` | イベントが全くディスパッチされなかったことをアサート |
| `assertDispatchedInOrder(events)` | イベントが特定の順序でディスパッチされたことをアサート |
| `assertDispatchedWith(event, data)` | 特定のデータでイベントがディスパッチされたことをアサート |
| `dispatched(event)` | ディスパッチされたイベントのインスタンスをすべて取得 |

### データベーステスト

実際のデータベースに影響を与えずにテストするためのデータベースフェイクを使用します：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { DatabaseFake, RefreshDatabase } from '@guren/testing'

describe('Userモデル', () => {
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

### HTTPテスト

コントローラテストヘルパーでHTTPエンドポイントをテストします：

```typescript
import { describe, it, expect } from 'bun:test'
import { createControllerContext } from '@guren/testing'
import UserController from '../app/Http/Controllers/UserController'

describe('UserController', () => {
  it('ユーザー一覧を返す', async () => {
    const ctx = createControllerContext('/users')
    const controller = new UserController()
    controller.setContext(ctx)

    const response = await controller.index()

    expect(response.status).toBe(200)
  })

  it('新しいユーザーを作成する', async () => {
    const ctx = createControllerContext('/users', {
      method: 'POST',
      body: { email: 'new@example.com', name: 'New User' },
    })
    const controller = new UserController()
    controller.setContext(ctx)

    const response = await controller.store()

    expect(response.status).toBe(201)
  })
})
```

### ベストプラクティス

1. **beforeEachでフェイクをリセット** - 常にクリーンな状態から開始します。
2. **具体的なアサーションを使用** - 可能な限り`assertSent`より`assertSentWith`を優先します。
3. **失敗ケースをテスト** - エラーシナリオでイベント/メールが送信されないことを検証します。
4. **テストを分離** - 各テストは独立している必要があります。

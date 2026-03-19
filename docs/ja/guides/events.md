# イベントガイド

Gurenはアプリケーション内のコンポーネントを疎結合にするための、シンプルかつ強力なイベントシステムを提供します。イベントを使用することで、アプリケーション内で発生した出来事を他の部分がリッスンして反応できるようになります。

## コアコンセプト

- **Event** – アプリケーション内で発生した出来事を表すクラス。イベントはその出来事に関するデータを持つ。
- **EventManager** – リスナーの登録とイベントの発行を行う中央ハブ。
- **Listener** – イベントが発行された時に反応する関数またはクラス。

## イベントの作成

### 基本的なイベント

`Event`基底クラスを拡張してカスタムイベントを作成：

```ts
import { Event } from '@guren/core'

export class UserRegistered extends Event {
  constructor(
    public readonly userId: string,
    public readonly email: string
  ) {
    super()
  }
}
```

### CLIを使用

CLIを使用してイベントクラスを生成：

```bash
bunx guren make:event UserRegistered
```

これにより`app/Events/UserRegistered.ts`が作成されます：

```ts
import { Event } from '@guren/core'

export class UserRegistered extends Event {
  constructor() {
    super()
  }
}
```

### イベントプロパティ

すべてのイベントは以下を持ちます：

- `timestamp` – イベントが作成された日時（自動設定）
- `eventName` – イベント識別子（デフォルトはクラス名）

```ts
class OrderPlaced extends Event {
  // カスタムイベント名（オプション）
  static get eventName(): string {
    return 'orders.placed'
  }

  constructor(
    public readonly orderId: string,
    public readonly total: number
  ) {
    super()
  }
}
```

## リスナーの登録

### 基本的な使い方

```ts
import { EventManager } from '@guren/core'
import { UserRegistered } from '@/app/Events/UserRegistered'

const events = new EventManager()

// リスナーを登録
events.on(UserRegistered, async (event) => {
  console.log(`ユーザー ${event.email} が ${event.timestamp} に登録しました`)
})

// イベントを発行
await events.emit(new UserRegistered('123', 'user@example.com'))
```

### 一度だけのリスナー

```ts
// リスナーは最初の呼び出し後に自動的に削除される
events.once(ApplicationStarted, (event) => {
  console.log(`アプリがポート ${event.port} で起動しました`)
})
```

### リスナーの優先度

優先度の高いリスナーが先に実行されます：

```ts
// 2番目に実行（デフォルト優先度: 0）
events.on(UserRegistered, (e) => console.log('2番目'))

// 1番目に実行（高い優先度）
events.on(UserRegistered, (e) => console.log('1番目'), { priority: 10 })

// 3番目に実行（低い優先度）
events.on(UserRegistered, (e) => console.log('3番目'), { priority: -10 })
```

### 購読解除

```ts
// サブスクリプションハンドルを使用
const subscription = events.on(UserRegistered, handler)
subscription.unsubscribe()

// または直接
events.off(UserRegistered, handler)

// イベントの全リスナーを削除
events.off(UserRegistered)
```

## リスナークラス

複雑なリスナーには、クラスベースのリスナーを使用：

```bash
bunx guren make:listener SendWelcomeEmail
```

```ts
// app/Listeners/SendWelcomeEmail.ts
import { Listener } from '@guren/core'
import { UserRegistered } from '@/app/Events/UserRegistered'
import { mail } from '@guren/core'

export class SendWelcomeEmail extends Listener<UserRegistered> {
  // このリスナーが処理するイベント
  static event = UserRegistered

  // オプション: リスナーの実行をキューに入れる
  static shouldQueue = true
  static queue = 'emails'

  // オプション: リスナーの優先度
  static priority = 10

  async handle(event: UserRegistered): Promise<void> {
    await mail(mailManager)
      .to(event.email)
      .subject('ようこそ！')
      .text('ご登録ありがとうございます！')
      .send()
  }

  // オプション: 条件付きでイベントを処理
  shouldHandle(event: UserRegistered): boolean {
    // 内部メール以外にのみ送信
    return !event.email.endsWith('@internal.example.com')
  }

  // オプション: 失敗を処理
  async failed(event: UserRegistered, error: Error): Promise<void> {
    console.error(`${event.email}へのウェルカムメール送信に失敗:`, error)
  }
}
```

### クラスリスナーの登録

```ts
import { SendWelcomeEmail } from '@/app/Listeners/SendWelcomeEmail'

// リスナークラスを登録
const listenerClass = SendWelcomeEmail
const instance = new listenerClass()

events.on(
  listenerClass.event,
  async (event) => {
    if (instance.shouldHandle?.(event) ?? true) {
      try {
        await instance.handle(event)
      } catch (error) {
        await instance.failed?.(event, error as Error)
      }
    }
  },
  {
    priority: listenerClass.priority,
    queue: listenerClass.shouldQueue ? listenerClass.queue : undefined,
  }
)
```

## イベントの発行

### 逐次実行

リスナーは優先度順に1つずつ実行されます：

```ts
// リスナーは順番に実行される
await events.emit(new UserRegistered('123', 'user@example.com'))
```

### 並列実行

順序が重要でない場合の高速実行：

```ts
// リスナーは並行して実行される
await events.emitParallel(new UserRegistered('123', 'user@example.com'))
```

## 組み込みイベント

Gurenはいくつかの組み込みイベントを提供します：

### HTTPイベント

```ts
import { RequestReceived, RequestFinished } from '@guren/core'

// リクエストを受信した時
events.on(RequestReceived, (event) => {
  console.log(`${event.method} ${event.path}`)
})

// リクエストが完了した時
events.on(RequestFinished, (event) => {
  console.log(`${event.method} ${event.path} - ${event.status} (${event.durationMs}ms)`)
})
```

### 認証イベント

```ts
import { UserAuthenticated, UserLoggedOut } from '@guren/core'

events.on(UserAuthenticated, (event) => {
  console.log(`ユーザー ${event.userId} が ${event.guard} でログインしました`)
})

events.on(UserLoggedOut, (event) => {
  console.log(`ユーザー ${event.userId} がログアウトしました`)
})
```

### キューイベント

```ts
import { JobProcessed, JobFailed } from '@guren/core'

events.on(JobProcessed, (event) => {
  console.log(`ジョブ ${event.jobName} が ${event.durationMs}ms で処理されました`)
})

events.on(JobFailed, (event) => {
  console.error(`ジョブ ${event.jobName} が失敗:`, event.error.message)
})
```

### アプリケーションイベント

```ts
import { ApplicationStarted, ApplicationShutdown } from '@guren/core'

events.on(ApplicationStarted, (event) => {
  console.log(`サーバーが ${event.host}:${event.port} で起動中`)
})

events.on(ApplicationShutdown, (event) => {
  console.log(`シャットダウン中: ${event.reason}`)
})
```

## キュー対応リスナー

リスナーを非同期処理のためにキューにディスパッチ：

```ts
// キュー統合を設定
import { setQueueDriver, MemoryDriver } from '@guren/core'
setQueueDriver(new MemoryDriver())

// キュー対応リスナーを登録
events.on(
  UserRegistered,
  async (event) => {
    // これはキューワーカーで実行される
    await sendWelcomeEmail(event)
  },
  { queue: 'emails' }
)
```

## EventManagerユーティリティ

```ts
const events = new EventManager()

// イベントにリスナーがあるか確認
if (events.hasListeners(UserRegistered)) {
  await events.emit(new UserRegistered(...))
}

// リスナー数を取得
const count = events.listenerCount(UserRegistered)

// リスナーを持つ全イベント名を取得
const eventNames = events.eventNames()

// イベントの全リスナーを取得
const listeners = events.getListeners(UserRegistered)

// 全リスナーを削除
events.removeAllListeners()
```

## テスト

```ts
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { EventManager } from '@guren/core'
import { UserRegistered } from '@/app/Events/UserRegistered'

describe('Events', () => {
  let events: EventManager

  beforeEach(() => {
    events = new EventManager()
  })

  test('イベント発行時にリスナーが呼ばれる', async () => {
    const listener = mock(() => {})

    events.on(UserRegistered, listener)
    await events.emit(new UserRegistered('123', 'test@example.com'))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('onceリスナーは最初の呼び出し後に削除される', async () => {
    const listener = mock(() => {})

    events.once(UserRegistered, listener)
    await events.emit(new UserRegistered('123', 'a@example.com'))
    await events.emit(new UserRegistered('456', 'b@example.com'))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('リスナーは優先度順に実行される', async () => {
    const order: string[] = []

    events.on(UserRegistered, () => order.push('低'), { priority: -10 })
    events.on(UserRegistered, () => order.push('デフォルト'))
    events.on(UserRegistered, () => order.push('高'), { priority: 10 })

    await events.emit(new UserRegistered('123', 'test@example.com'))

    expect(order).toEqual(['高', 'デフォルト', '低'])
  })

  test('イベントデータがリスナーに渡される', async () => {
    let receivedEvent: UserRegistered | null = null

    events.on(UserRegistered, (event) => {
      receivedEvent = event
    })

    await events.emit(new UserRegistered('123', 'test@example.com'))

    expect(receivedEvent?.userId).toBe('123')
    expect(receivedEvent?.email).toBe('test@example.com')
  })
})
```

## ベストプラクティス

1. **起きたことを名前にする**: 過去形を使用（`UserRegistered`、`OrderPlaced`、`PaymentFailed`）。

2. **イベントは不変に**: `readonly`プロパティを使用し、リスナーでイベントデータを変更しない。

3. **1つの出来事に1つのイベント**: 各イベントは1つの具体的な出来事を表すべき。

4. **リスナーは焦点を絞る**: 各リスナーは1つのことを行う。複数の副作用には複数のリスナーを使用。

5. **遅い処理にはキュー対応リスナーを使用**: メール送信やAPI呼び出しなどでメインフローをブロックしない。

6. **リスナーエラーを処理**: リスナーロジックをtry-catchで囲むか、クラスリスナーの`failed()`メソッドを使用。

7. **優先度は控えめに使用**: ほとんどのリスナーはデフォルト優先度を使用。順序が本当に重要な場合のみ調整。

8. **並列発行を検討**: リスナーが独立していて順序が不要な場合は`emitParallel()`を使用。

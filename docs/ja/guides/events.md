# イベントガイド

Guren のイベントシステムを使うと、アプリケーション内のコンポーネント同士を疎結合に保てます。起きた出来事をイベントとして発行しておけば、アプリの別の部分がそれをリッスンして反応できます。

おすすめの使い方は、`@guren/core` から event API をインポートし、リスナーやプロバイダーを一か所でまとめて登録することです。コントローラーはドメインイベントを発火するだけにしておきます。

## コアコンセプト

- **Event**: アプリケーション内で起きた出来事を表すクラスです。その出来事に関するデータを持ちます。
- **EventManager**: リスナーの登録とイベントの発行を受け持つ中心的な仕組みです。
- **Listener**: イベントが発行されたときに反応する関数またはクラスです。

## イベントの作成

### 基本的なイベント

独自のイベントは、`Event` 基底クラスを継承して作ります。

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

イベントクラスは CLI でも生成できます。

```bash
bunx guren make:event UserRegistered
```

実行すると `app/Events/UserRegistered.ts` が作られます。

```ts
import { Event } from '@guren/core'

export class UserRegistered extends Event {
  constructor() {
    super()
  }
}
```

### イベントプロパティ

どのイベントも、次のプロパティを持っています。

- `timestamp`: イベントが作られた日時（自動で設定されます）
- `eventName`: イベントの識別子（既定はクラス名）

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

### コンテナバインディングファサードを使用

アプリケーションコンテナからファサードを作っておくと、`EventManager` をあちこちに引き回さずに済みます。

```ts
import { createFacades } from '@guren/core'
import { UserRegistered } from '@/app/Events/UserRegistered'

const { Events } = createFacades(app.container)

// リスナーを登録
Events.on(UserRegistered, async (event) => {
  console.log(`ユーザー ${event.email} が ${event.timestamp} に登録しました`)
})

// イベントを発行
await Events.emit(new UserRegistered('123', 'user@example.com'))
```

### 直接インスタンス化

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

優先度の高いリスナーが先に実行されます。

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

処理が込み入ったリスナーは、クラスとして書きます。

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

`events.listen()` はクラスの static プロパティを読み取ります。`event` で対象のイベントを、`priority` で実行順を決め、`shouldQueue` と `queue` を指定するとキューに送ります（[キュー対応リスナー](#キュー対応リスナー)を参照）。`shouldHandle()` が定義されていれば最初にそれを評価し、リスナーのインスタンスはイベントごとに作ります。`handle()` が投げた例外は必ず発行元まで伝わり、クラスに `failed()` があればそこにも報告されます。インライン実行では例外が出た時点で、キューではジョブがリトライを使い切った時点で報告され、`Job.failed` が呼ばれるタイミングと同じです。

```ts
import { SendWelcomeEmail } from '@/app/Listeners/SendWelcomeEmail'

events.listen(SendWelcomeEmail)
```

## イベントの発行

### 逐次実行

リスナーは優先度の高い順に 1 つずつ実行されます。

```ts
// リスナーは順番に実行される
await events.emit(new UserRegistered('123', 'user@example.com'))
```

### 並列実行

実行順が問題にならない場合は、リスナーを並行して走らせると速く終わります。

```ts
// リスナーは並行して実行される
await events.emitParallel(new UserRegistered('123', 'user@example.com'))
```

## 組み込みイベント

Guren には、あらかじめ次のイベントが用意されています。

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

`queue` を付けて登録したリスナーは、その場では実行されず、キューワーカーで実行されます。アプリが `QueueManager` を `queue` としてバインドしていれば（`QueueServiceProvider` でも自前のプロバイダでもかまいません）、`EventServiceProvider` がイベントとキューをつなぎます。

```ts
import { createApp, EventServiceProvider, QueueServiceProvider } from '@guren/core'

const app = createApp({
  providers: [EventServiceProvider, QueueServiceProvider],
})
```

```ts
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

イベントを 1 回発行すると、キュー対応リスナーごとに、イベントのフィールドを載せたジョブが 1 つずつキューに積まれます。そのためリトライもリスナーごとに行われ、1 つが失敗しても、ほかのリスナーまで再実行されることはありません。ワーカーはイベントをそのクラスのインスタンスとして組み立て直し、メッセージが指定するリスナーを実行します。このため、ワーカープロセスでも発行側と同じ方法で、しかも**同じ順序で**キュー対応リスナーを登録しておく必要があります。通常は同じプロバイダが両方のプロセスで boot するので、特別な作業は要りません。ワーカーにないリスナーを指定したメッセージは、別のリスナーを実行することなく失敗します。

キューを往復しても変わってはいけない名前が 2 つあります。ワーカーはイベントクラスを名前から探すので、ジョブで `jobName` を固定するのと同じように、リネームや識別子の mangling に備えてイベント名を固定しておきます。

```ts
export class UserRegistered extends Event {
  static override eventName = 'UserRegistered'
}
```

`eventName` はクラス自身に定義したものだけが有効で、サブクラスは親クラスで固定した名前を引き継ぎません。イベントを発行せずにキューを処理するだけのワーカーでは、`events.registerEvent(UserRegistered)` でクラスを登録します。`events.on(UserRegistered, ...)` を呼んでいれば、この登録も済んでいます。

1 つのマネージャーの中では、1 つのイベント名は 1 つのクラスにしか使えません。リスナーは名前をキーにして登録されるので、ほかのクラスが使っている名前で別のクラスを `on()`・`listen()`・`registerEvent()` に渡すと、マネージャーは両方のクラス名を挙げた警告を 1 度だけ出します。そのまま放っておくと、それぞれのクラスのリスナーが相手のクラスの発行でも動き、キューから戻ったイベントは後から登録したほうのクラスとして組み立て直されます。どちらかのクラス名を変えるか、どちらかに独自の `eventName` を付けてください。次のメジャーバージョンでは、これはエラーになる予定です。

キューにつながっていないマネージャーに `queue` 付きのリスナーを登録すると、警告を 1 度出したうえでインラインで実行します。次のメジャーバージョンでは、ここで例外を投げるようになります。

`EventManager` を自分で組み立てるアプリでは、1 行でキューにつなげます。

```ts
import { createEventManager, createQueueEventDispatcher } from '@guren/core'

const events = createEventManager()
events.setQueueDispatcher(createQueueEventDispatcher())
```

ディスパッチャは `Job.dispatch()` と同じキュードライバを使って送るので、この場合もコンテナに `queue` としてバインドした `QueueManager` が必要です。バインドされていないと、キューに載せるはずのリスナーは警告を 1 度出してインラインで実行されます。

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

1. **起きたことを名前にする**: イベント名は過去形にします（`UserRegistered`、`OrderPlaced`、`PaymentFailed`）。

2. **イベントは不変に**: プロパティは `readonly` にし、リスナーの中でイベントのデータを書き換えないようにします。

3. **1つの出来事に1つのイベント**: 1 つのイベントには、具体的な出来事を 1 つだけ表させます。

4. **リスナーは焦点を絞る**: 1 つのリスナーにやらせることは 1 つにし、副作用が複数あるならリスナーを分けます。

5. **遅い処理にはキュー対応リスナーを**: メール送信や API 呼び出しでメインの処理を止めないようにします。

6. **リスナーのエラーを処理する**: リスナーの処理を try-catch で囲むか、クラスリスナーの `failed()` メソッドを使います。

7. **優先度は控えめに**: ほとんどのリスナーは既定の優先度のままでかまいません。実行順が本当に結果を左右するときにだけ調整します。

8. **並列発行を検討する**: リスナーが互いに独立していて順序を気にしなくてよいなら、`emitParallel()` を使います。

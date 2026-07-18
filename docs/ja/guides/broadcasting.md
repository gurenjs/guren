# ブロードキャスティングガイド

Guren は接続されたクライアントへのリアルタイムイベント配信のためのブロードキャスティングシステムを提供します。ライブ通知、チャットアプリケーション、リアルタイムダッシュボードなどの機能を構築するのに便利です。

## コアコンセプト

- **BroadcastManager** – チャンネル、ドライバー、SSEクライアントを管理する中央ハブ。
- **Channel** – イベントをブロードキャストするための名前付き経路。チャンネルはpublic、private、presenceのいずれか。
- **BroadcastDriver** – イベント配信のバックエンド（MemoryまたはRedis）。
- **SSE (Server-Sent Events)** – ブラウザクライアントへのイベントプッシュの組み込みサポート。
- **WebSocket Clients** – ソケットクライアントの登録・購読・解除を扱う基盤API。

## チャンネルタイプ

- **Public Channels** – 誰でも購読可能。
- **Private Channels** – 購読にユーザー認証が必要。
- **Presence Channels** – 誰が購読しているかを追跡（「オンラインユーザー」機能など）。

## 基本的な使い方

### セットアップ

```ts
import { BroadcastManager } from '@guren/core'

const broadcast = new BroadcastManager({
  default: 'memory',
  drivers: {
    memory: () => new MemoryDriver(),
  },
})

// イベントをブロードキャスト
await broadcast.broadcast('notifications', 'NewMessage', {
  content: 'Hello world!',
})
```

### チャンネルヘルパーの使用

```ts
// Publicチャンネル
await broadcast.toChannel('notifications').broadcast('NewMessage', data)

// Privateチャンネル（自動的に'private-'プレフィックスが付く）
await broadcast.toPrivate('orders.123').broadcast('OrderUpdated', {
  status: 'shipped',
})

// Presenceチャンネル（自動的に'presence-'プレフィックスが付く）
await broadcast.toPresence('chat.general').broadcast('UserJoined', {
  user: 'John',
})
```

### チャンネルの購読

```ts
const channel = broadcast.toChannel('notifications')

// イベントを購読
const unsubscribe = channel.subscribe((event, data) => {
  console.log(`イベント: ${event}`, data)
})

// 後で購読解除
unsubscribe()
```

## チャンネル認可

### Publicチャンネル

```ts
broadcast.channel('notifications', () => true)
broadcast.channel('public.*', () => true) // ワイルドカードパターン
```

### Privateチャンネル

Privateチャンネルには認証が必要です。

```ts
broadcast.privateChannel('orders.{orderId}', async (channel, user) => {
  // チャンネル名からorderIdを抽出
  const orderId = channel.replace('private-orders.', '')

  // ユーザーがこの注文を所有しているか確認
  const order = await Order.find(orderId)
  return order?.userId === user.id
})

// ユーザー固有のチャンネル
broadcast.privateChannel('user.{userId}', (channel, user) => {
  const userId = channel.replace('private-user.', '')
  return String(user.id) === userId
})
```

### Presenceチャンネル

Presenceチャンネルは認可時にメンバー情報を返します。

```ts
broadcast.presenceChannel('chat.{roomId}', async (channel, user) => {
  if (!user) return null // 認可されていない

  // プレゼンスメンバー情報を返す
  return {
    id: user.id,
    info: {
      name: user.name,
      avatar: user.avatar,
    },
  }
})
```

### パターンマッチング

チャンネルパターンはサポート：
- `{param}` – ドット以外の任意のセグメントにマッチ
- `*` – 任意の単一セグメントにマッチ
- `**` – 複数セグメントにマッチ

```ts
broadcast.channel('posts.*', () => true)           // posts.123, posts.456
broadcast.channel('users.{id}.posts', authorizer)  // users.1.posts
broadcast.channel('admin.**', isAdmin)             // admin.users, admin.settings.email
```

## Server-Sent Events (SSE)

### SSEエンドポイント

```ts
import { Router } from '@guren/core'

export function registerBroadcastRoutes(router: Router): void {
  router.get('/broadcasting/events', broadcast.sseMiddleware({
    pingInterval: 30000,
    retry: 3000,
    // Resolve the connecting user so channels requested up front via
    // ?channels= can be authorized when the stream opens
    getUser: (ctx) => ctx.get('user'),
  }))

  router.post('/broadcasting/auth', broadcast.authMiddleware({
    getUser: (ctx) => ctx.get('user'),
  }))
}
```

SSE エンドポイントは `?channels=` クエリパラメータを受け取り、指定したチャンネルをストリーム開始前に購読します。リクエストされた各チャンネルは `getUser` が返すユーザーに対して認可されるため、パブリックチャンネルであれば追加のリクエストなしに素の `EventSource` だけで動作します。プライベート・プレゼンスチャンネルは後から `/broadcasting/auth` を通じて購読します（[チャンネルの認可（クライアント）](#チャンネルの認可クライアント)を参照）。

## WebSocket 基盤

`BroadcastManager` に WebSocket クライアントのライフサイクルAPIが追加されています。  
クライアント登録、チャンネル購読、解除を SSE と同じブロードキャスト経路で扱えます。

```ts
const clientId = broadcast.registerWebSocketClient({
  send: (event, data) => socket.send(JSON.stringify({ event, data })),
  close: () => socket.close(),
})

broadcast.subscribeWebSocketClient(clientId, 'notifications')

// 後で解除
broadcast.unsubscribeWebSocketClient(clientId, 'notifications')
broadcast.removeWebSocketClient(clientId)
```

このAPIを使うことで、Bun の WebSocket upgrade ルートを既存の channel/driver 構成に接続できます。

### 型安全 channel codegen（Wave 3）

`guren codegen` で `.guren/channels.gen.ts` が生成されるようになりました。  
サーバー側の broadcast 利用箇所からチャンネルとイベント名を抽出します。

```ts
// app/Providers/BroadcastProvider.ts
broadcast.channel('announcements', () => true)
broadcast.privateChannel('posts.{id}', () => true)
broadcast.broadcast('announcements', 'NewPost', { id: 1 })
```

生成物には以下が含まれます。

- `ChannelName` – パターンを含むチャンネル名 union（template literal type）
- `ChannelEvents` – チャンネルごとのイベント map（リテラル/object/array の payload 型を推論）
- `channelEventManifest` – 検出済み channel/event の runtime manifest

```ts
import type { ChannelEvents } from '@/.guren/channels.gen'
import { createUseChannel } from '@guren/inertia-client'

const useChannel = createUseChannel<ChannelEvents>()
const feed = useChannel('announcements')
const off = feed.on('NewPost', (payload) => {
  console.log(payload)
})
```

これにより、フロント側で channel/event 名だけでなく payload 形状も型安全に扱えます。

### E2E 型安全リアルタイム（Wave 7）

生成された `ChannelEvents` をサーバー側 emit にも適用すると、送信時 payload もコンパイル時に検証できます。

```ts
import type { ChannelEvents } from '@/.guren/channels.gen'
import { createTypedBroadcaster } from '@guren/core'

const typed = createTypedBroadcaster<ChannelEvents>(broadcast)

await typed.broadcast('announcements', 'NewPost', { id: 1 }) // payload も型チェック
await typed.toChannel('announcements').broadcast('NewPost', { id: 2 })
```

### クライアント側の統合

パブリックチャンネルは `?channels=` クエリパラメータで指定すると、ストリーム開始と同時に購読されます。接続直後、サーバーは `clientId` と「認可・購読済みチャンネルの一覧」を載せた `connected` イベントを送信します。プライベート・プレゼンスチャンネルの購読に必要になるため、`clientId` を必ず保持してください。

```ts
// Connect to SSE and subscribe public channels up front
const eventSource = new EventSource(
  '/broadcasting/events?channels=notifications,announcements'
)

// The server sends a `connected` event first — capture the clientId
let clientId: string | null = null

eventSource.addEventListener('connected', (e) => {
  const data = JSON.parse(e.data)
  clientId = data.clientId
  console.log('Subscribed channels:', data.channels)
})

// Messages are dispatched by EVENT name, not channel name
eventSource.addEventListener('NewMessage', (e) => {
  const data = JSON.parse(e.data)
  console.log('New message:', data)
})

// Listen for ping
eventSource.addEventListener('ping', () => {
  console.log('Keepalive ping')
})

eventSource.onerror = (error) => {
  console.error('Connection error', error)
}
```

### チャンネルの認可（クライアント）

プライベート・プレゼンスチャンネルは `POST /broadcasting/auth` を通じて購読します。`{ clientId, channel }` を含む 1 回のリクエストで、現在のユーザーに対するチャンネル認可と SSE 接続への購読が同時に行われます。レスポンスにはチャンネルごとに両方の結果が含まれます。

```ts
async function subscribeToPrivateChannel(channel: string) {
  if (!clientId) {
    throw new Error('Not connected yet — wait for the `connected` event')
  }

  // Authorize AND subscribe in one call
  const response = await fetch('/broadcasting/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, channel }),
    credentials: 'include',
  })

  const result = await response.json()
  // e.g. { 'private-orders.123': { authorized: true, subscribed: true } }
  return result[channel]?.authorized && result[channel]?.subscribed
}

if (await subscribeToPrivateChannel('private-orders.123')) {
  // Events arrive on the same EventSource, dispatched by event name
  eventSource.addEventListener('OrderUpdated', (e) => {
    const data = JSON.parse(e.data)
    console.log('Order updated:', data)
  })
}
```

> [!IMPORTANT]
> リクエストから `clientId` を省略するとチャンネルの認可のみが行われ（`subscribed: false`）、イベントはブラウザに届きません。必ず `connected` イベントで受け取った `clientId` を送信してください。

> [!NOTE]
> `private-` / `presence-` プレフィックスを持つチャンネルは、認可関数が未登録の場合デフォルトで拒否されます。クライアントが購読する前に `broadcast.privateChannel()` / `broadcast.presenceChannel()` で登録してください。

## 設定

### Redisドライバー

本番環境とマルチサーバーサポートにはRedisドライバーを使用します。

```ts
import { BroadcastManager, RedisDriver } from '@guren/core'
import { createRedisClient } from '@guren/core'

const redis = createRedisClient({ url: process.env.REDIS_URL })

const broadcast = new BroadcastManager({
  default: 'redis',
  drivers: {
    redis: () => new RedisDriver(redis),
    memory: () => new MemoryDriver(), // テスト用フォールバック
  },
})
```

### 複数のドライバー

```ts
const broadcast = new BroadcastManager({
  default: 'redis',
  drivers: {
    redis: () => new RedisDriver(redis),
    memory: () => new MemoryDriver(),
  },
})

// 特定のドライバーを使用
const driver = broadcast.driver('memory')
await driver.publish('test-channel', 'TestEvent', data)
```

## イベントからのブロードキャスト

イベントシステムとブロードキャスティングを統合できます。

```ts
import { Event } from '@guren/core'

export class OrderShipped extends Event {
  constructor(
    public readonly orderId: string,
    public readonly trackingNumber: string
  ) {
    super()
  }

  // BroadcastableEventインターフェースを実装
  broadcastOn(): string[] {
    return [`private-orders.${this.orderId}`]
  }

  broadcastAs(): string {
    return 'OrderShipped'
  }

  broadcastWith(): Record<string, unknown> {
    return {
      orderId: this.orderId,
      trackingNumber: this.trackingNumber,
    }
  }
}

// 使用方法
const event = new OrderShipped('123', 'ABC456')

for (const channel of event.broadcastOn()) {
  await broadcast.broadcast(
    channel,
    event.broadcastAs?.() ?? event.eventName,
    event.broadcastWith?.() ?? {}
  )
}
```

## Presenceチャンネルメンバー

Presenceチャンネルの参加者を追跡できます。

```ts
import { PresenceChannel } from '@guren/core'

const channel = broadcast.toPresence('chat.general')

// 現在のメンバーを取得（PresenceBroadcastDriverが必要）
const driver = broadcast.driver() as PresenceBroadcastDriver
const members = driver.getMembers('presence-chat.general')

// メンバー参加をブロードキャスト
await channel.broadcast('MemberJoined', {
  member: { id: user.id, name: user.name },
})

// メンバー退出をブロードキャスト
await channel.broadcast('MemberLeft', {
  memberId: user.id,
})
```

## テスト

```ts
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { BroadcastManager, MemoryDriver } from '@guren/core'

describe('Broadcasting', () => {
  let broadcast: BroadcastManager

  beforeEach(() => {
    broadcast = new BroadcastManager({
      default: 'memory',
      drivers: {
        memory: () => new MemoryDriver(),
      },
    })
  })

  test('チャンネルにブロードキャストする', async () => {
    const received: unknown[] = []

    broadcast.driver().subscribe('test', (event) => {
      received.push(event)
    })

    await broadcast.broadcast('test', 'TestEvent', { value: 1 })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      channel: 'test',
      event: 'TestEvent',
      data: { value: 1 },
    })
  })

  test('Privateチャンネルを認可する', async () => {
    broadcast.privateChannel('orders.{orderId}', (channel, user) => {
      return user?.id === '123'
    })

    const result = await broadcast.authorize('private-orders.456', { id: '123' })
    expect(result).toBe(true)

    const denied = await broadcast.authorize('private-orders.456', { id: '999' })
    expect(denied).toBe(false)
  })

  test('Presenceチャンネルがメンバー情報を返す', async () => {
    broadcast.presenceChannel('chat.{roomId}', (channel, user) => {
      if (!user) return null
      return { id: user.id, info: { name: user.name } }
    })

    const result = await broadcast.authorize('presence-chat.1', {
      id: '123',
      name: 'John',
    })

    expect(result).toMatchObject({
      id: '123',
      info: { name: 'John' },
    })
  })
})
```

## ベストプラクティス

1. **本番環境ではRedisを使用**: Memoryドライバーは複数サーバー間で動作しない。

2. **機密チャンネルを認可**: PrivateとPresenceチャンネルは常に適切な認可で保護。

3. **ペイロードは小さく**: 帯域幅を削減するため、必要なデータのみをブロードキャスト。

4. **切断を処理**: クライアント側に再接続ロジックを実装。

5. **リアルタイム機能にはPresenceチャンネルを使用**: オンラインユーザー追跡、入力中インジケーターなど。

6. **メッセージ順序を考慮**: イベントは順不同で届く可能性があるため、順序が重要な場合はタイムスタンプを含める。

7. **購読をクリーンアップ**: コンポーネントのアンマウント時やユーザー退出時は常に購読解除。

8. **認可ロジックをテスト**: セキュリティ問題を防ぐためチャンネル認可のテストを書く。

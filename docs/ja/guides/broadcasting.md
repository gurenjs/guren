# ブロードキャスティングガイド

Gurenは接続されたクライアントへのリアルタイムイベント配信のためのブロードキャスティングシステムを提供します。ライブ通知、チャットアプリケーション、リアルタイムダッシュボードなどの機能を構築するのに便利です。

## コアコンセプト

- **BroadcastManager** – チャンネル、ドライバー、SSEクライアントを管理する中央ハブ。
- **Channel** – イベントをブロードキャストするための名前付き経路。チャンネルはpublic、private、presenceのいずれか。
- **BroadcastDriver** – イベント配信のバックエンド（MemoryまたはRedis）。
- **SSE (Server-Sent Events)** – ブラウザクライアントへのイベントプッシュの組み込みサポート。

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

Privateチャンネルには認証が必要です：

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

Presenceチャンネルは認可時にメンバー情報を返します：

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
import { Route } from '@guren/server'

// SSE接続エンドポイント
Route.get('/broadcasting/events', broadcast.sseMiddleware({
  pingInterval: 30000, // 30秒ごとにping送信
  retry: 3000,         // クライアントリトライ遅延
}))

// チャンネル認証エンドポイント
Route.post('/broadcasting/auth', broadcast.authMiddleware({
  getUser: (ctx) => ctx.get('user'),
}))
```

### クライアント側の統合

```ts
// SSEに接続
const eventSource = new EventSource('/broadcasting/events')

eventSource.onopen = () => {
  console.log('接続しました')
}

eventSource.onerror = (error) => {
  console.error('接続エラー', error)
}

// イベントをリッスン
eventSource.addEventListener('NewMessage', (e) => {
  const data = JSON.parse(e.data)
  console.log('新しいメッセージ:', data)
})

// pingをリッスン
eventSource.addEventListener('ping', () => {
  console.log('キープアライブping')
})
```

### チャンネルの認可（クライアント）

```ts
async function subscribeToChannel(channel: string) {
  // チャンネルを認可
  const response = await fetch('/broadcasting/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel }),
    credentials: 'include',
  })

  const result = await response.json()

  if (result[channel].authorized) {
    // チャンネルイベントを購読
    eventSource.addEventListener(channel, (e) => {
      const data = JSON.parse(e.data)
      handleChannelEvent(channel, data)
    })
  }
}
```

## 設定

### Redisドライバー

本番環境とマルチサーバーサポート向け：

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

イベントシステムとブロードキャスティングを統合：

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

Presenceチャンネルの参加者を追跡：

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

6. **メッセージ順序を考慮**: イベントは順不同で届く可能性がある；順序が重要な場合はタイムスタンプを含める。

7. **購読をクリーンアップ**: コンポーネントのアンマウント時やユーザー退出時は常に購読解除。

8. **認可ロジックをテスト**: セキュリティ問題を防ぐためチャンネル認可のテストを書く。

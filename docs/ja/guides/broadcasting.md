# ブロードキャスティングガイド

Guren のブロードキャスティングは、接続しているクライアントにイベントをリアルタイムで届ける仕組みです。ライブ通知、チャットアプリケーション、リアルタイムのダッシュボードといった機能を作るときに使います。

## コアコンセプト

- **BroadcastManager**: チャンネル、ドライバー、SSE クライアントをまとめて管理する中心的な仕組みです。
- **Channel**: イベントをブロードキャストするための名前付きの経路です。public、private、presence のいずれかの種類があります。
- **BroadcastDriver**: イベントを配信するバックエンド（Memory または Redis）です。
- **SSE (Server-Sent Events)**: ブラウザのクライアントにイベントを送る、組み込みの仕組みです。
- **WebSockets**: 同じチャンネルをソケットで配信するエンドポイントと、独自のソケットルート向けのライフサイクル API です。

## チャンネルタイプ

- **Public Channels**: 誰でも購読できます。
- **Private Channels**: 購読するにはユーザー認証が必要です。
- **Presence Channels**: 誰が購読しているかを追跡します（「オンラインのユーザー」表示など）。

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

Private チャンネルを購読するには認証が必要です。

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

Presence チャンネルの認可関数は、認可したときにメンバーの情報を返します。

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

チャンネルのパターンには、次の記法が使えます。
- `{param}`: ドットを含まない任意のセグメントにマッチします
- `*`: 任意の 1 セグメントにマッチします
- `**`: 複数のセグメントにマッチします

```ts
broadcast.channel('posts.*', () => true)           // posts.123, posts.456
broadcast.channel('users.{id}.posts', authorizer)  // users.1.posts
broadcast.channel('admin.**', isAdmin)             // admin.users, admin.settings.email
```

## Server-Sent Events (SSE)

### SSEエンドポイント

```ts
import { AUTH_CONTEXT_KEY, Router } from '@guren/core'
import type { AuthContext } from '@guren/core'
import type { Context } from 'hono'

const currentUser = async (ctx: Context) => {
  const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
  return (await auth?.user()) ?? null
}

export function registerBroadcastRoutes(router: Router): void {
  router.get('/broadcasting/events', broadcast.sseMiddleware({
    pingInterval: 30000,
    retry: 3000,
    // Resolve the connecting user so channels requested up front via
    // ?channels= can be authorized when the stream opens
    getUser: (ctx) => currentUser(ctx as Context),
  }))

  router.post('/broadcasting/auth', broadcast.authMiddleware({
    getUser: (ctx) => currentUser(ctx as Context),
  }))
}
```

`getUser` にはリクエストコンテキストが `unknown` 型で渡され、Promise を返してもかまいません。`currentUser()` は、認証コンテキストからログイン中のユーザーを取り出す関数です。このあとの例でも `currentUser()` を使います。

SSE エンドポイントは `?channels=` クエリパラメータを受け取り、指定されたチャンネルをストリームの開始前に購読します。リクエストされたチャンネルは、どれも `getUser` が返すユーザーに対して認可されます。そのため、パブリックチャンネルなら、素の `EventSource` だけで、追加のリクエストなしに購読できます。プライベートチャンネルとプレゼンスチャンネルは、あとから `/broadcasting/auth` を通して購読します（[チャンネルの認可（クライアント）](#チャンネルの認可クライアント)を参照）。

## WebSocket 基盤

`broadcast.webSocketMiddleware()` は、SSE エンドポイントの WebSocket 版です。GET ルートに設定すると、リクエストがソケットにアップグレードされます。届くイベント、チャンネルの認可関数、ドライバーは SSE と共通です。

```ts
import { Router } from '@guren/core'

export function registerBroadcastRoutes(router: Router): void {
  router.get('/broadcasting/socket', broadcast.webSocketMiddleware({
    // The user of the upgrade request authorizes every channel the socket
    // subscribes to, for as long as it stays open
    getUser: (ctx) => currentUser(ctx as Context),
  }))
}
```

アップグレードには Bun のサーバーが必要で、それは `app.listen()` が用意します。`app.listen()` は、`hono/bun` の `upgradeWebSocket` が必要とする WebSocket ハンドラーを `Bun.serve` に渡すからです。アップグレードできないランタイム（Node 上の `app.fetch()`、Workers、Lambda）では、このルートは 501 を返します。

フレームはすべて JSON です。サーバーは `{ event, data }` を送り、最初に届く `connected` イベントには、`clientId` と、`?channels=` で購読したチャンネルの一覧が入っています。クライアントは `{ action, channel }` を送って、購読と購読解除を行います。各メッセージは `POST /broadcasting/auth` へのリクエストと同じように認可され、その結果が `subscription` イベントで返ります。

```ts
const socket = new WebSocket(
  `${location.origin.replace(/^http/, 'ws')}/broadcasting/socket?channels=announcements`
)

socket.addEventListener('open', () => {
  socket.send(JSON.stringify({ action: 'subscribe', channel: 'private-orders.123' }))
})

socket.addEventListener('message', (e) => {
  const { event, data } = JSON.parse(e.data)
  if (event === 'subscription') {
    // e.g. { channel: 'private-orders.123', authorized: true, subscribed: true }
    console.log('Subscription:', data)
  } else if (event === 'OrderUpdated') {
    console.log('Order updated:', data)
  }
})

// Later
socket.send(JSON.stringify({ action: 'unsubscribe', channel: 'private-orders.123' }))
```

メッセージは届いた順に処理されます。拒否されたチャンネルには `authorized: false` が返り、そのチャンネルのイベントは届きません。応答待ちのメッセージが 32 件を超えたソケットはコード 1008 で閉じられ、4 KB を超えるメッセージは無視されます。`connected` で受け取った `clientId` は、`POST /broadcasting/auth` でも使えます。

ソケットは開いたときのユーザーを持ち続けるので、ログアウトしても閉じられません。ユーザーがログアウトしたときや権限を失ったときは、そのユーザーのクライアントを削除してください。

```ts
for (const client of broadcast.getWebSocketClients()) {
  if (client.userId === user.id) broadcast.removeWebSocketClient(client.id)
}
```

### Origin の検査

WebSocket のハンドシェイクには CORS が適用されず、ブラウザはどのサイトから開かれたソケットにもアプリの Cookie を付けて送ります。そのため、ほかのサイトのページが、ログイン中のユーザーとしてソケットを開けてしまいます（Cross-Site WebSocket Hijacking）。このルートは、`Origin` のホストがリクエスト自身のホストと違うハンドシェイクを 403 で拒否します。アプリの手前にあるプロキシが `Host` を書き換える場合は、公開しているオリジンを列挙してください。

```ts
broadcast.webSocketMiddleware({
  getUser: (ctx) => currentUser(ctx as Context),
  allowedOrigins: ['https://app.example.com'],
})
```

`Origin` のないハンドシェイクはブラウザ以外からの接続で、ユーザーの Cookie を持っていません。この検査は通りますが、ほかのソケットと同じくチャンネルごとの認可は必要です。TLS はふつうプロキシで終端されるので、この検査はホストだけを比べ、スキームは比べません。同じホストの平文 HTTP のページも通るため、ページを HTTPS に限定するのは HSTS に任せます。`allowedOrigins` に書いたオリジンは、スキームまで一致したときだけ通します。

### 独自のソケットルート

独自のプロトコルを使うルートでは、これまでどおり下位の API を使えます。`subscribeWebSocketClient()` は、SSE の `subscribeClient()` と同じく認可を行いません。サーバーが選んだチャンネルはそのまま渡してかまいませんが、クライアントが指定したチャンネルは、先に `broadcast.authorize()` で認可してください。クライアントをユーザー ID 付きで登録しておくと、`POST /broadcasting/auth` は、そのユーザーからのリクエストに限ってチャンネルを追加します。ソケットの open ハンドラーには次のように書きます。

```ts
const clientId = broadcast.registerWebSocketClient({
  userId: user.id,
  send: (event, data) => ws.send(JSON.stringify({ event, data })),
  close: () => ws.close(),
})

if (await broadcast.authorize(channel, user)) {
  broadcast.subscribeWebSocketClient(clientId, channel)
}

// When the socket closes
broadcast.removeWebSocketClient(clientId)
```

こうしたルートの手前に `createWebSocketOriginGuard()` を置くと、同じ `Origin` の検査が行われます。`allowedOrigins` も同じように渡せます。

```ts
import { createWebSocketOriginGuard } from '@guren/core'

router.get('/socket', socketHandler, createWebSocketOriginGuard())
```

`broadcast.disconnectAll()` を呼ぶと、SSE のストリームだけでなく WebSocket のクライアントも閉じられます。

### 型安全 channel codegen

`guren codegen` は、サーバー側で broadcast を使っている箇所からチャンネル名とイベント名を取り出し、`.guren/channels.gen.ts` を生成します。

```ts
// app/Providers/BroadcastProvider.ts
broadcast.channel('announcements', () => true)
// private チャンネルには実際のチェックが必要です。`() => true` だと
// 誰でも他人のチャンネルを購読できてしまいます。
broadcast.privateChannel('posts.{id}', async (channel, user) => {
  const post = await Post.find(channel.replace('private-posts.', ''))
  return post?.authorId === user?.id
})
broadcast.broadcast('announcements', 'NewPost', { id: 1 })
```

生成されるファイルには、次のものが含まれます。

- `ChannelName`: パターンも表せるチャンネル名の union 型（template literal type）
- `ChannelEvents`: チャンネルごとのイベントの map（リテラル/object/array の payload から型を推論）
- `channelEventManifest`: 見つかったチャンネルとイベントの、実行時に参照できる manifest

```ts
import type { ChannelEvents } from '@/.guren/channels.gen'
import { createUseChannel } from '@guren/inertia-client'

const useChannel = createUseChannel<ChannelEvents>()
const feed = useChannel('announcements')
const off = feed.on('NewPost', (payload) => {
  console.log(payload)
})
```

これで、フロントエンドではチャンネル名やイベント名だけでなく、payload の形も型付きで扱えます。

`useChannel(name)` は、呼び出すたびに `endpoint?channels=name` に対して専用の `EventSource` を開きます（既定の endpoint は `/broadcasting/events` です。endpoint にすでにクエリ文字列がある場合は `&channels=` でつなぎます）。引数に渡したチャンネルは、型の指定に使われるだけでなく、サーバーが実際に購読するチャンネルにもなります。後で紹介する `?channels=` の例と同じく、ストリームの開始時に認可と購読が行われます。SSE ルートが `getUser` でユーザーを解決していれば、プライベートチャンネルとプレゼンスチャンネルも同じ呼び出しで購読できます。サーバーが拒否したチャンネルは、`connected` イベントの `channels` 一覧に載らず、イベントも届きません。チャンネルごとにストリームを 1 本ずつ開くのは意図した設計です。イベントはイベント名で振り分けられるので、チャンネルごとにストリームを分けておくことで、`feed.on('NewPost', …)` が「`announcements` の `NewPost`」を指すようになります。URL を自分で組み立てる場合は、`channelStreamUrl(endpoint, channel)` を使えます。

### E2E 型安全リアルタイム

生成された `ChannelEvents` をサーバー側の送信にも使うと、送る payload もコンパイル時に検査できます。

```ts
import type { ChannelEvents } from '@/.guren/channels.gen'
import { createTypedBroadcaster } from '@guren/core'

const typed = createTypedBroadcaster<ChannelEvents>(broadcast)

await typed.broadcast('announcements', 'NewPost', { id: 1 }) // payload も型チェック
await typed.toChannel('announcements').broadcast('NewPost', { id: 2 })
```

### クライアント側の統合

パブリックチャンネルは、`?channels=` クエリパラメータで指定しておくと、ストリームが開いた時点で購読されます。接続した直後に、サーバーは `clientId` と、認可して購読したチャンネルの一覧を載せた `connected` イベントを送ってきます。`clientId` はあとでプライベートチャンネルやプレゼンスチャンネルを購読するときに必要なので、必ず保持しておいてください。

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

プライベートチャンネルとプレゼンスチャンネルは、`POST /broadcasting/auth` を通して購読します。`{ clientId, channel }` を送る 1 回のリクエストで、現在のユーザーに対するチャンネルの認可と、SSE 接続（または WebSocket）への購読がまとめて行われます。レスポンスには、チャンネルごとにその両方の結果が入っています。

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
> リクエストで `clientId` を省略すると、チャンネルの認可だけが行われ（`subscribed: false`）、イベントはブラウザに届きません。`connected` イベントで受け取った `clientId` を必ず送ってください。

> [!NOTE]
> `private-` / `presence-` プレフィックスの付いたチャンネルは、認可関数が登録されていなければ既定で拒否されます。クライアントが購読する前に、`broadcast.privateChannel()` / `broadcast.presenceChannel()` で登録してください。

## 設定

### Redisドライバー

本番環境や、複数のサーバーで動かす構成では Redis ドライバーを使います。

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

イベントシステムとブロードキャスティングは組み合わせて使えます。

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

Presence チャンネルでは、参加しているメンバーを追跡できます。

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

1. **本番環境ではRedisを使用**: Memory ドライバーは、複数のサーバーをまたいでは動きません。

2. **機密チャンネルを認可**: Private チャンネルと Presence チャンネルは、必ず適切な認可で守ります。

3. **ペイロードは小さく**: 帯域を節約するため、必要なデータだけをブロードキャストします。

4. **切断を処理**: クライアント側に再接続の処理を用意します。

5. **リアルタイム機能にはPresenceチャンネルを使用**: オンラインのユーザー表示や入力中インジケーターなどに使います。

6. **メッセージ順序を考慮**: イベントが送った順に届くとは限らないので、順序が大事な場合はタイムスタンプを含めます。

7. **購読をクリーンアップ**: コンポーネントのアンマウント時やユーザーの退出時には、必ず購読を解除します。

8. **認可ロジックをテスト**: セキュリティ上の問題を防ぐため、チャンネルの認可にはテストを書きます。

# 通知ガイド

Guren では、メール・データベース・Slackなど複数のチャンネルへの通知送信を、ひとつのAPIで扱えます。通知はクラスとして書くため、再利用もテストも簡単です。

## コアコンセプト

- **Notification**: 通知そのものを表すクラス。配信チャンネルごとにメソッドを持ちます。
- **NotificationManager**: チャンネルの登録と通知の送信を行う中央ハブ。
- **Notifiable**: 通知を受け取れるエンティティ（ユーザー、チームなど）のインターフェース。
- **Channel**: 配信メカニズム（mail、database、Slackなど）。

## 通知の作成

### 基本的な通知

```ts
import { Notification } from '@guren/core'
import type { Notifiable, NotificationMailMessage } from '@guren/core'

export class OrderShipped extends Notification {
  constructor(
    private readonly order: Order,
    private readonly trackingNumber: string
  ) {
    super()
  }

  // 配信チャンネルを定義
  via(notifiable: Notifiable): string[] {
    return ['mail', 'database']
  }

  // メールコンテンツ
  toMail(notifiable: Notifiable): NotificationMailMessage {
    return {
      subject: `注文 #${this.order.id} が発送されました！`,
      html: `
        <h1>ご注文が発送されました！</h1>
        <p>追跡番号: ${this.trackingNumber}</p>
        <a href="/orders/${this.order.id}">注文を確認</a>
      `,
    }
  }

  // データベースレコード
  toDatabase(notifiable: Notifiable): Record<string, unknown> {
    return {
      orderId: this.order.id,
      trackingNumber: this.trackingNumber,
      message: 'ご注文が発送されました',
    }
  }
}
```

### CLIを使用

```bash
bunx guren make:notification OrderShipped
```

## 通知の送信

### セットアップ

```ts
import {
  NotificationManager,
  MailChannel,
  DatabaseChannel,
} from '@guren/core'

const notifications = new NotificationManager()

// チャンネルを登録
notifications
  .registerChannel('mail', new MailChannel(mailManager))
  .registerChannel('database', new DatabaseChannel())
```

### ユーザーへの送信

```ts
// ユーザーはNotifiableインターフェースを実装する必要がある
const user: Notifiable = {
  id: 1,
  email: 'user@example.com',
  routeNotificationFor(channel: string): string | null {
    if (channel === 'mail') return this.email
    return null
  },
}

// 通知を送信
await notifications.send(user, new OrderShipped(order, 'ABC123'))
```

### 複数ユーザーへの送信

```ts
await notifications.sendToMany(users, new OrderShipped(order, 'ABC123'))
```

### 即時送信（キューをスキップ）

```ts
// 通知がキュー設定されていても即座に送信
await notifications.sendNow(user, new OrderShipped(order, 'ABC123'))
```

## 通知チャンネル

### メールチャンネル

```ts
import { MailChannel } from '@guren/core'

const mailChannel = new MailChannel(mailManager, {
  from: 'notifications@example.com',
})

// 通知クラス内
toMail(notifiable: Notifiable): NotificationMailMessage {
  return {
    subject: 'ようこそ！',
    html: '<h1>プラットフォームへようこそ！</h1>',
    text: 'プラットフォームへようこそ！',
    from: 'hello@example.com',  // デフォルトを上書き
    replyTo: 'support@example.com',
    cc: ['admin@example.com'],
    attachments: [{
      filename: 'welcome.pdf',
      path: './storage/welcome.pdf',
    }],
  }
}
```

### データベースチャンネル

通知をデータベースに保存できます。

```ts
import { DatabaseChannel } from '@guren/core'

const databaseChannel = new DatabaseChannel({
  store: async (notifiable, notification) => {
    await Notification.create({
      id: notification.id,
      type: notification.type,
      notifiableId: notifiable.id,
      notifiableType: 'User',
      data: notification.data,
      readAt: null,
      createdAt: notification.createdAt,
    })
  },
})

// 通知クラス内
toDatabase(notifiable: Notifiable): Record<string, unknown> {
  return {
    title: '新しいコメント',
    message: '投稿にコメントがつきました',
    postId: this.post.id,
    commentId: this.comment.id,
  }
}
```

### Slackチャンネル

```ts
import { SlackChannel } from '@guren/core'

const slackChannel = new SlackChannel({
  webhookUrl: process.env.SLACK_WEBHOOK_URL,
  channel: '#notifications',  // デフォルトチャンネル
  username: '通知ボット',
})

// 通知クラス内
toSlack(notifiable: Notifiable): SlackMessage {
  return {
    text: `注文 #${this.order.id} が発送されました！`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*注文発送* :package:\n追跡番号: ${this.trackingNumber}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '注文を確認' },
            url: `https://example.com/orders/${this.order.id}`,
          },
        ],
      },
    ],
  }
}
```

### メモリチャンネル（テスト用）

```ts
import { MemoryChannel } from '@guren/core'

const memoryChannel = new MemoryChannel()

// 後で送信された通知を確認
const sent = memoryChannel.getSentNotifications()
```

## Notifiableインターフェース

通知を受け取るエンティティは`Notifiable`を実装する必要があります。

```ts
import type { Notifiable } from '@guren/core'

class User implements Notifiable {
  id: number
  email: string
  slackId?: string
  phone?: string

  routeNotificationFor(channel: string): string | null {
    switch (channel) {
      case 'mail':
        return this.email
      case 'slack':
        return this.slackId ?? null
      case 'sms':
        return this.phone ?? null
      default:
        return null
    }
  }
}
```

### Notifiable の型名を固定する

データベースチャネルは各レコードに `notifiableType` を保存します。既定ではコンスト
ラクタ名が使われますが、この名前が失われる場面が2つあります。バンドラーによるマングル
と、キューのペイロードから復元された Notifiable がプレーンオブジェクトになり、コンス
トラクタ名が `Object` になる場合です。

`notifiableType` を宣言しておけば型名を固定できます。通知側の `Notification.type` に
あたる仕組みです。

```ts
class User implements Notifiable {
  notifiableType = 'User'

  routeNotificationFor(channel: string): string | null {
    // ...
  }
}
```

宣言した型名はキューのペイロードにシリアライズされ、ワーカー側で組み立て直される
Notifiable にも引き継がれるので、往復しても失われません。

## キュー対応通知

### キューの設定

```ts
export class WelcomeNotification extends Notification {
  // キューを有効化
  static shouldQueue = true

  // キュー名を指定（オプション）
  static queue = 'notifications'

  // ミリ秒単位で遅延を追加（オプション）
  static delay = 5000  // 5秒

  via(notifiable: Notifiable): string[] {
    return ['mail']
  }

  toMail(notifiable: Notifiable): NotificationMailMessage {
    return {
      subject: 'ようこそ！',
      html: '<h1>アプリへようこそ！</h1>',
    }
  }
}
```

### キューのセットアップ

```ts
import { createQueueManager, MemoryDriver } from '@guren/core'

const queue = createQueueManager({
  default: 'memory',
  drivers: {
    memory: () => new MemoryDriver(),
  },
})

queue.driver()

// shouldQueue = trueの通知はキューに入る
await notifications.send(user, new WelcomeNotification())

// ワーカーで処理
// bunx guren queue:work --queue=notifications
```

### 別プロセスで動かすワーカー

キューに入った通知はデータとして保存されるので、ワーカーは配信時にクラスを復元します。通知を送ったプロセスとワーカーが同じであれば、この登録は自動で行われます。`queue:work` を独立したプロセスとして動かす場合は、必要な通知クラスをプロバイダから登録してください。

```ts
import { ServiceProvider, registerNotification } from '@guren/core'
import { WelcomeNotification } from '@/app/Notifications/WelcomeNotification'

export class NotificationServiceProvider extends ServiceProvider {
  register(): void {
    registerNotification(WelcomeNotification)
  }
}
```

未登録の通知はエラーになります。何も配信されないまま黙って終わることはありません。

保存されるのは通知が自分で持つプロパティだけなので、次の2つはキューを越えられません。

- **コンストラクタ引数**。コンストラクタは再実行されません。チャンネルが必要とする値は、上記の `WelcomeNotification` のようにプロパティとして保持してください。
- **JSONで表現できない値**（`Map`・`Set`・`#private` フィールドなど）。素の値を使ってください。

ルーティングは影響を受けません。`routeNotificationFor()` はキュー投入時に呼ばれ、解決されたルートが通知と一緒に運ばれるので、受信者ごとのアドレスやWebhookはそのまま届きます。

## 条件付き通知

### shouldSendメソッド

```ts
class OrderStatusNotification extends Notification {
  constructor(private readonly order: Order) {
    super()
  }

  // ユーザーが通知を有効にしている場合のみ送信
  async shouldSend(notifiable: Notifiable): Promise<boolean> {
    const user = notifiable as User
    return user.notificationsEnabled && !user.isDeleted
  }

  via(notifiable: Notifiable): string[] {
    const channels = ['database']

    // ユーザーがオプトインしている場合のみメールを追加
    if ((notifiable as User).emailNotifications) {
      channels.push('mail')
    }

    return channels
  }

  toMail(notifiable: Notifiable): NotificationMailMessage {
    return {
      subject: `注文 #${this.order.id} 更新`,
      html: `<p>注文ステータス: ${this.order.status}</p>`,
    }
  }

  toDatabase(notifiable: Notifiable): Record<string, unknown> {
    return {
      orderId: this.order.id,
      status: this.order.status,
    }
  }
}
```

## カスタムチャンネル

カスタム通知チャンネルを作成できます。

```ts
import type { NotificationChannel, Notifiable } from '@guren/core'
import type { Notification } from '@guren/core'

class SMSChannel implements NotificationChannel {
  readonly name = 'sms'

  constructor(private readonly twilioClient: TwilioClient) {}

  async send(notifiable: Notifiable, notification: Notification): Promise<void> {
    const phone = notifiable.routeNotificationFor('sms')
    if (!phone) return

    // 通知からSMSコンテンツを取得
    const message = (notification as any).toSMS?.(notifiable)
    if (!message) return

    await this.twilioClient.messages.create({
      to: phone,
      from: process.env.TWILIO_FROM,
      body: message.body,
    })
  }
}

// チャンネルを登録
notifications.registerChannel('sms', new SMSChannel(twilioClient))

// 通知で使用
class OrderConfirmation extends Notification {
  via(notifiable: Notifiable): string[] {
    return ['mail', 'sms']
  }

  toSMS(notifiable: Notifiable) {
    return {
      body: `注文 #${this.order.id} 確認！合計: ¥${this.order.total}`,
    }
  }
}
```

## テスト

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  NotificationManager,
  MemoryChannel,
  Notification,
} from '@guren/core'
import type { Notifiable, NotificationMailMessage } from '@guren/core'

class TestNotification extends Notification {
  via() {
    return ['memory']
  }

  toMail(): NotificationMailMessage {
    return { subject: 'テスト', html: '<p>テスト</p>' }
  }
}

describe('Notifications', () => {
  let notifications: NotificationManager
  let memoryChannel: MemoryChannel

  beforeEach(() => {
    memoryChannel = new MemoryChannel()
    notifications = new NotificationManager({
      channels: { memory: memoryChannel },
    })
  })

  test('通知を送信する', async () => {
    const user: Notifiable = {
      id: 1,
      routeNotificationFor: () => 'test@example.com',
    }

    await notifications.send(user, new TestNotification())

    const sent = memoryChannel.getSentNotifications()
    expect(sent).toHaveLength(1)
    expect(sent[0].notification).toBeInstanceOf(TestNotification)
  })

  test('shouldSendを尊重する', async () => {
    class ConditionalNotification extends Notification {
      shouldSend() {
        return false
      }
      via() {
        return ['memory']
      }
    }

    const user: Notifiable = {
      id: 1,
      routeNotificationFor: () => 'test@example.com',
    }

    await notifications.send(user, new ConditionalNotification())

    expect(memoryChannel.getSentNotifications()).toHaveLength(0)
  })

  test('複数チャンネルに送信する', async () => {
    const mailChannel = new MemoryChannel()
    const dbChannel = new MemoryChannel()

    notifications.registerChannel('mail', mailChannel)
    notifications.registerChannel('database', dbChannel)

    class MultiChannelNotification extends Notification {
      via() {
        return ['mail', 'database']
      }
      toMail() {
        return { subject: 'テスト', html: '<p>テスト</p>' }
      }
      toDatabase() {
        return { message: 'テスト' }
      }
    }

    const user: Notifiable = {
      id: 1,
      routeNotificationFor: () => 'test@example.com',
    }

    await notifications.send(user, new MultiChannelNotification())

    expect(mailChannel.getSentNotifications()).toHaveLength(1)
    expect(dbChannel.getSentNotifications()).toHaveLength(1)
  })
})
```

## ベストプラクティス

1. **イベントごとに1つの通知**: イベントが違えば通知クラスも分ける。

2. **通知は焦点を絞る**: 各通知の目的をひとつに絞る。

3. **重要でない通知にはキューを使用**: メールやSlackの通知は、処理をブロックしないようキューに入れる。

4. **条件ロジックにはshouldSendを実装**: 呼び出し側で送信前に条件を判定せず、`shouldSend()`にまとめる。

5. **通知内容をテスト**: 通知メッセージが正しいかを検証するテストを書く。

6. **チャンネル失敗を適切に処理**: 各チャンネルは、他のチャンネルを巻き込まずにエラーをログに残す。

7. **型付きペイロードを使用**: 通知データのインターフェースを定義して型安全にする。

8. **アプリ内通知にはデータベース通知を保存**: 通知センターにはデータベースチャンネルを使う。

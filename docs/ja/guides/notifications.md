# 通知ガイド

Guren では、メール、データベース、Slack など複数のチャンネルへの通知を 1 つの API で送れます。通知はクラスとして書くので、使い回しやすく、テストも簡単です。

## コアコンセプト

- **Notification**: 通知そのものを表すクラスです。配信チャンネルごとにメソッドを持ちます。
- **NotificationManager**: チャンネルを登録し、通知を送る中心的な役割を担います。
- **Notifiable**: 通知を受け取れるエンティティ（ユーザー、チームなど）が実装するインターフェースです。
- **Channel**: 通知の配信手段です（mail、database、Slack など）。

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

`app/Notifications/OrderShippedNotification.ts` が作成されます。中身は `Notification` を継承したクラスで、`via()`、`toMail()`、`toDatabase()`、`toArray()` の中身を書いて使います。`type` は、生成したクラスの名前で固定されています。

```ts
override get type(): string {
  return this.constructor === OrderShippedNotification ? 'OrderShippedNotification' : this.constructor.name
}
```

`type` は、キューのワーカーが通知を復元するときのキーで、データベースチャンネルが保存する `type` にもなります。上書きしなければクラス名が使われますが、クラス名はバンドラーに書き換えられることがあります。別の名前にしたい場合は、通知を初めてキューに積むか保存する前に、この文字列を書き換えてください。

コンストラクタを比較しているのは、名前を固定する対象を生成したクラスだけに限るためです。ジョブの `jobName` が宣言したクラスでだけ有効なのと同じ扱いです。getter は継承されるので、この比較がないとサブクラスも同じ `type` を返し、レジストリ上でこのクラスを置き換えてしまいます。サブクラスは、自分で `type` を上書きするまで、自身のクラス名で解決されます。

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

通知をデータベースに保存します。

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

通知を受け取るエンティティには、`Notifiable` を実装します。

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

データベースチャンネルは、各レコードに `notifiableType` を保存します。既定ではコンストラクタ名が使われますが、この名前は 2 つの場面で失われます。1 つはバンドラーが名前をマングルした場合、もう 1 つはキューのペイロードから復元した Notifiable がプレーンオブジェクトになり、コンストラクタ名が `Object` になる場合です。

`notifiableType` を宣言しておけば、型名を固定できます。通知側の `Notification.type` にあたる仕組みです。

```ts
class User implements Notifiable {
  notifiableType = 'User'

  routeNotificationFor(channel: string): string | null {
    // ...
  }
}
```

宣言した型名はキューのペイロードにシリアライズされ、ワーカー側で組み立て直す Notifiable にも引き継がれます。キューを往復しても失われません。

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

キューに入った通知はデータとして保存されるので、ワーカーは配信するときにクラスを復元します。通知を送ったプロセスでワーカーも動いているなら、クラスの登録は自動で行われます。`queue:work` を独立したプロセスとして動かす場合は、ワーカーが必要とする通知クラスをプロバイダから登録してください。

```ts
import { ServiceProvider, registerNotification } from '@guren/core'
import { WelcomeNotification } from '@/app/Notifications/WelcomeNotification'

export class NotificationServiceProvider extends ServiceProvider {
  register(): void {
    registerNotification(WelcomeNotification)
  }
}
```

登録されていない通知はエラーになるので、何も配信されないまま黙って終わることはありません。

レジストリのキーは通知の `type` で、デフォルトはクラス名です。ほかのクラスが使っている `type` で別のクラスを登録すると、両方のクラス名を挙げた警告が 1 度だけ出ます。`registerNotification()` で登録した場合も、キューに積んだときの自動登録でも同じです。このときワーカーは、後から登録したクラスを組み立てます。どちらかのクラス名を変えるか、`type` の getter をオーバーライドしてください。古い `type` を解決できるように、1 つのクラスを 2 つ目の `type` でも登録するのは問題なく、警告も出ません。次のメジャーバージョンでは、警告ではなく例外を投げるようになります。

保存されるのは通知が自分で持つプロパティだけなので、次の 2 つはキューを通すと失われます。

- **コンストラクタ引数**: コンストラクタは再実行されません。チャンネルが必要とする値は、上の `WelcomeNotification` のようにプロパティとして持たせてください。
- **JSON で表現できない値**（`Map`、`Set`、`#private` フィールドなど）: 素の値を使ってください。

ルーティングには影響しません。`routeNotificationFor()` はキューに積むときに呼ばれ、解決したルートが通知と一緒に運ばれるので、受信者ごとのアドレスや Webhook はそのまま届きます。

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

通知チャンネルは自分で作ることもできます。

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

1. **イベントごとに通知を 1 つ作る**: イベントが違えば、通知クラスも分けます。

2. **通知の目的を絞る**: 1 つの通知には、はっきりした目的を 1 つだけ持たせます。

3. **急がない通知はキューに入れる**: メールや Slack の通知は、処理を止めないようにキューに入れます。

4. **送信条件は shouldSend に書く**: 送信前に呼び出し側で条件を判定するのではなく、`shouldSend()` にまとめます。

5. **通知の内容をテストする**: 通知のメッセージが正しいことを確かめるテストを書きます。

6. **チャンネルの失敗をうまく扱う**: 各チャンネルはエラーをログに残し、ほかのチャンネルを巻き込まないようにします。

7. **ペイロードに型を付ける**: 通知データのインターフェースを定義して、型安全にします。

8. **アプリ内通知はデータベースに保存する**: 通知センターには、データベースチャンネルを使います。

# Live Props

live prop は、ブロードキャストされたイベントでデータの変更が伝わると、自分で読み込み直す prop です。コントローラーでイベントを指定しておくと、サーバーはそのイベントのチャンネルを描画するページに書き込み、ブラウザはアプリのブロードキャスト用ソケットでそのチャンネルを購読します。イベントが届くと Inertia が partial reload でその prop だけを取り直すので、ほかのユーザーの変更が、再読み込みもポーリングもなしに画面へ反映されます。

Inertia 3.11 の live props を Guren の[ブロードキャスティング](./broadcasting.md)の上で動かす仕組みなので、Laravel Echo や Pusher、別のソケットサーバーは要りません。`@inertiajs/react` 3.11 以降が必要です。

## セットアップ

用意するものは 3 つで、サーバーのソケットルート、ブラウザの transport、コントローラーの `live()` です。

まず、GET ルートに `webSocketMiddleware()` をマウントします。このルートは Bun 上の `app.listen()` で動かす必要がありますが、scaffold したアプリはどれもそうなっています（[WebSocket 基盤](./broadcasting.md#websocket-基盤)を参照してください）。

```ts
import { Router } from '@guren/core'

export function registerBroadcastRoutes(router: Router): void {
  router.get('/broadcasting/socket', broadcast.webSocketMiddleware())
}
```

次に、`resources/js/app.tsx` で transport を `startInertiaClient()` に渡します。

```tsx
import { pageManifest } from '@/.guren/pages.gen'
import { startInertiaClient } from '@guren/inertia-client/app'
import { liveTransport } from '@guren/inertia-client/live'

const pages = import.meta.glob('./pages/**/*.tsx')

void startInertiaClient({ pages, pageManifest, live: liveTransport() })
```

あとは prop を live にして、それを更新するイベントを指定します。

```ts
import { Controller, live } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { OrderUpdated } from '@/app/Events/OrderUpdated'

export class OrderController extends Controller {
  async show() {
    const order = this.model(Order)
    return this.inertia(pages.orders.Show, {
      order: live(() => OrderResource.make(order), { on: new OrderUpdated(order.id) }),
    })
  }
}
```

注文を変更する箇所では、同じイベントをブロードキャストします。

```ts
await broadcast.broadcastEvent(new OrderUpdated(order.id))
```

すると、その注文を表示しているすべてのページで `order` prop が読み込み直されます。ページコンポーネントを変える必要はありません。live prop も解決後の値としてページに届き、ほかの prop と同じくページの `Props` で型が付きます。

## イベント

`on` にはクラスではなくイベントのインスタンスを渡します。`broadcastOn()` は多くの場合イベント自身のフィールドを読む（`private-orders.${this.orderId}`）ので、その注文がどのチャンネルに送られるかはインスタンスでないと決まらないためです。

```ts
import { Event } from '@guren/core'

export class OrderUpdated extends Event {
  static override eventName = 'OrderUpdated'

  constructor(readonly orderId: number) {
    super()
  }

  broadcastOn(): string[] {
    return [`private-orders.${this.orderId}`]
  }

  broadcastWith(): Record<string, unknown> {
    return { orderId: this.orderId }
  }
}
```

`live()` に渡したインスタンスからは、`broadcastEvent()` が送るときと同じ規則でチャンネルと名前が読み取られます。名前は、イベントに `broadcastAs()` があればその戻り値、なければ `eventName` です。この名前は `static eventName` か `broadcastAs()` で固定してください。固定しないとクラス名がそのままイベント名になり、本番用のバンドルで別のモジュールに同じ名前のクラスがあるとクラス名が変わることがあります（`OrderUpdated2`）。そうなると prop は二度と更新されず、エラーもどこにも出ません。

1 つの prop で複数のイベントを待つことも、どのクラスにも対応しないイベントを待つこともできます。

```ts
live(() => OrderResource.make(order), {
  on: [new OrderUpdated(order.id), new OrderCancelled(order.id), { event: 'refund.issued', channel: `private-orders.${order.id}` }],
})
```

渡した値は `live()` を呼んだ時点で検査されます。チャンネルのないイベントや空の `on`、インスタンスの代わりに渡したクラスは、それを書いたアクションの中で例外になります。

## deferred、always、lazy な prop との組み合わせ

`live()` はほかのどの prop の入力も包めますが、必ずいちばん外側に置きます。

| 入力 | 初回の訪問 | イベントでの更新 |
|---|---|---|
| `live(() => value, …)` | 解決して送る | 更新される |
| `live(defer(() => value), …)` | ほかの deferred prop と同じく、ページの描画後に読み込む | 読み込み後に更新される |
| `live(always(value), …)` | 送る | 更新される。partial reload のたびにも送る |

逆の順に書くと例外になります。`always(live(…))` は `always()` を呼んだ時点で、`live(…)` を返す deferred のコールバックは deferred のリクエストで解決するときに失敗します。どちらも `this.inertia()` の prop の入力としてコンパイル時にも弾かれます。deferred な live prop も、ほかの deferred prop と同じく、ページの `Props` では省略可能にしておく必要があります。

## 間引きと非表示のタブ

近い時刻に届いたイベントは 1 回のリロードにまとめられます。既定では各 prop のリロードは 1 秒に 1 回までなので、更新の多い prop にはミリ秒でもっと長い間隔を指定します。

```ts
activity: live(defer(() => Activity.where('orderId', order.id).get()), {
  on: new ActivityLogged(order.id),
  throttle: 4000,
}),
```

全 prop の既定値は `liveTransport({ throttle })` で変えられます。非表示のタブはリクエストを送らず、溜まったリロードはタブがまた表示されたときに実行されます。裏でも読み込み直したいときは `liveTransport({ pauseWhenHidden: false })` を渡してください。

## private チャンネル

ブラウザは live prop のチャンネルをソケットで購読するので、許可するかどうかは、ほかの購読者のときと同じくチャンネルの認可関数で決まります。

```ts
broadcast.privateChannel('orders.{orderId}', async (channel, user) => {
  const order = await Order.find(channel.replace('private-orders.', ''))
  return order?.customerId === user?.id
})
```

拒否されたチャンネルは、ブラウザのコンソールに一度だけ警告が出て、その prop はページを描画したときの値のまま残ります。イベントが新しい値そのものを運ぶことはなく、届いたイベントはリロードのきっかけになるだけです。リロードではミドルウェアと Policy を通ってコントローラーが動くので、prop にページ以上の情報が載ることはありません。ただしイベントの payload はチャンネルの購読者全員に届くので、live prop が待つイベントの payload は ID だけにしておいてください。

## 送信元を除く

注文を保存したユーザーは、レスポンスで新しい状態をもう受け取っています。リクエストを `except` に渡すと、そのユーザーのタブが二度目のリロードをしなくなります。

```ts
await broadcast.broadcastEvent(new OrderUpdated(order.id), { except: this.ctx })
```

transport は Inertia のリクエストすべてにソケット ID を付けて送り、マネージャーはその ID を持ち、かつサインイン中のユーザーのものであるソケットだけを除きます。詳しくは[送信元を除く](./broadcasting.md#送信元を除く)を参照してください。

## 再接続

ソケットが切れると、transport は間隔を少しずつ延ばしながら再接続し、すべてのチャンネルを購読し直してから、復帰したことを Inertia に伝えます。切れている間に送られたイベントは届いていないので、Inertia はこの時点で live prop をすべて読み込み直します。

## ソケットのない実行環境

`live()` はページにメタデータを足すだけなので、これを使うコントローラーはどの実行環境でも描画できます。Workers、Lambda、Vercel、Node ではソケットのルートが 501 を返し、transport は 5 回試したところで諦めてコンソールに一度だけ警告を出します。ページは描画したときの props のまま動き続けます。コントローラーに手を入れずにビルド単位で live props を止めたいときは、`startInertiaClient()` に `live` を渡さないでください。

## `guren check` が報告するもの

コントローラーが `live` を import していると、`guren check` は次の参考扱いの警告（`--ci` と `guren gate` は数えません）を出します。

| キー | 意味 |
|---|---|
| `live-props:socket-route` | どのファイルも `broadcast.webSocketMiddleware()` をマウントしておらず、transport の接続先がない |
| `live-props:event-name:…` | live prop が待つイベントに `broadcastAs()` も `static eventName` もない |
| `live-props:outermost:…` | `live()` が `always()` か deferred のコールバックの中にある |
| `live-props:unverifiable:…` | `live()` のオプションが、`on` をそのまま書いたオブジェクトリテラルではなく、どのイベントを待つのか読み取れない |

既存の [deferred props の警告](./frontend.md#deferred-props)も、`live()` の中の `defer()` を見るようになっています。また `bunx guren codegen` は、アプリが `broadcastEvent()` で送るイベントをイベントクラスから読み取り、`.guren/channels.gen.ts` に載せます。

## 制限

- live でなくなったキー（注文が未完了の間だけ `order` を live にするコントローラーなど）は、次に通常の訪問をするまで購読が残ります。そのあいだに届いたイベントのたびに 1 回リロードが走り、ふつうの値が返ります。
- イベントがリロードの代わりに新しい値を運ぶ Inertia のモードは使いません。transport がすべての payload から `__inertia` を取り除きます。
- Guren には merge props がありません。Inertia でも merge props は live にできません。

## 次のステップ

- [ブロードキャスティングガイド](./broadcasting.md): チャンネル、認可関数、ソケットのプロトコル
- [フロントエンドガイド](./frontend.md): partial reload と deferred props
- [Inertia プロトコル対応](./inertia.md): サーバーアダプタが実装している範囲

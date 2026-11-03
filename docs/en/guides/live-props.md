# Live Props

A live prop reloads itself when a broadcast event says its data changed. The controller names the event, the server lists that event's channels in the page it renders, and the browser subscribes over the app's broadcasting socket. When the event arrives, Inertia fetches that one prop again with a partial reload, so another user's change shows up without a refresh or a poll.

This builds on Inertia 3.11's live props and on Guren's [broadcasting](./broadcasting.md): there is no Laravel Echo, Pusher or separate socket server to run. It needs `@inertiajs/react` 3.11 or later.

## Setup

Three pieces: a socket route on the server, the transport in the browser, and `live()` in a controller.

Mount `webSocketMiddleware()` on a GET route. It needs `app.listen()` on Bun, which every scaffolded app uses (see [WebSocket Foundation](./broadcasting.md#websocket-foundation)):

```ts
import { Router } from '@guren/core'

export function registerBroadcastRoutes(router: Router): void {
  router.get('/broadcasting/socket', broadcast.webSocketMiddleware())
}
```

Pass the transport to `startInertiaClient()` in `resources/js/app.tsx`:

```tsx
import { pageManifest } from '@/.guren/pages.gen'
import { startInertiaClient } from '@guren/inertia-client/app'
import { liveTransport } from '@guren/inertia-client/live'

const pages = import.meta.glob('./pages/**/*.tsx')

void startInertiaClient({ pages, pageManifest, live: liveTransport() })
```

Then mark a prop live and name the event that refreshes it:

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

Wherever the order changes, broadcast the same event:

```ts
await broadcast.broadcastEvent(new OrderUpdated(order.id))
```

Every page showing that order reloads its `order` prop. The page component needs no change: a live prop arrives as the value it resolves to, typed by the page's `Props` as any other prop.

## Events

`on` takes an event instance, not a class. `broadcastOn()` usually reads the event's own fields (`private-orders.${this.orderId}`), so only an instance can say which channel this order broadcasts on:

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

`live()` reads the channels and the name off the instance with the same rule `broadcastEvent()` sends by: `broadcastAs()` if the event defines it, else its `eventName`. Pin that name with `static eventName` or `broadcastAs()`. Without it the name is the class name, and a production bundle can rename a class whose name another module also declares (`OrderUpdated2`); the prop then never refreshes and nothing reports an error.

A prop can listen for several events, and for an event no class describes:

```ts
live(() => OrderResource.make(order), {
  on: [new OrderUpdated(order.id), new OrderCancelled(order.id), { event: 'refund.issued', channel: `private-orders.${order.id}` }],
})
```

`live()` checks what it is given when it runs, so an event with no channels, an empty `on`, or a class passed where an instance belongs throws inside the action that wrote it.

## Deferred, always and lazy props

`live()` wraps any other prop input, and is always the outermost helper:

| Input | First visit | Refreshed by an event |
|---|---|---|
| `live(() => value, …)` | resolved and sent | yes |
| `live(defer(() => value), …)` | loaded after the page renders, like any deferred prop | yes, once loaded |
| `live(always(value), …)` | sent | yes, and sent on every partial reload |

Written the other way round, it throws: `always(live(…))` as soon as `always()` runs, and a deferred callback that returns `live(…)` when the deferred request resolves it. `this.inertia()` also rejects both as prop inputs at compile time. A deferred live prop still needs to be optional in the page's `Props`, as any deferred prop does.

## Throttling and hidden tabs

Events that arrive close together become one reload. Each prop reloads at most once a second by default; give a busier prop a longer interval in milliseconds:

```ts
activity: live(defer(() => Activity.where('orderId', order.id).get()), {
  on: new ActivityLogged(order.id),
  throttle: 4000,
}),
```

`liveTransport({ throttle })` changes the default for every prop. A hidden tab makes no requests; the reloads it owes run when it becomes visible again. Pass `liveTransport({ pauseWhenHidden: false })` to reload in the background too.

## Private channels

The browser subscribes to a live prop's channels on its socket, so the channel's authorizer decides exactly as it does for any other subscriber:

```ts
broadcast.privateChannel('orders.{orderId}', async (channel, user) => {
  const order = await Order.find(channel.replace('private-orders.', ''))
  return order?.customerId === user?.id
})
```

A refused channel is logged once in the browser console and its props keep the value the page rendered. An event never carries the new value itself: it only triggers the reload, which runs the controller with its middleware and policies, so a prop never shows the user more than the page would. The event's payload still reaches everyone on the channel, so keep the payload of an event a live prop listens for to identifiers.

## Skipping the sender

The user who saved the order already has the new state from the response. Pass the request as `except` so their own tab does not reload a second time:

```ts
await broadcast.broadcastEvent(new OrderUpdated(order.id), { except: this.ctx })
```

The transport sends its socket id with every Inertia request, and the manager skips only the socket that has that id and belongs to the signed-in user. [Skipping the sender](./broadcasting.md#skipping-the-sender) has the details.

## Reconnecting

When the socket drops, the transport reconnects with a growing delay, subscribes every channel again, and then tells Inertia it is back. Inertia reloads every live prop at that point, since any event sent while the socket was down never arrived.

## Runtimes without a socket

`live()` only adds metadata to the page, so a controller using it renders on every runtime. On Workers, Lambda, Vercel or Node, the socket route answers 501. The transport gives up after five attempts, warns once in the console, and the page keeps working with the props it rendered. Leave `live` out of `startInertiaClient()` to turn live props off for a build without touching a controller.

## What `guren check` reports

Once a controller imports `live`, `guren check` adds these advisory warnings (`--ci` and `guren gate` do not count them):

| Key | Meaning |
|---|---|
| `live-props:socket-route` | No file mounts `broadcast.webSocketMiddleware()`, so the transport has nothing to connect to |
| `live-props:event-name:…` | An event a live prop listens for has no `broadcastAs()` and no `static eventName` |
| `live-props:outermost:…` | `live()` sits inside `always()` or a deferred callback |
| `live-props:unverifiable:…` | The events cannot be read: the options are not an object literal with a literal `on`, or an event is not `new SomeEvent(…)` of a class the check finds under `app/` (through the controller's import when two files declare the name), or its base class is not one the check can read |

The existing [deferred props warning](./frontend.md#deferred-props) also sees a `defer()` inside `live()`. `bunx guren codegen` lists the events an app sends through `broadcastEvent()` in `.guren/channels.gen.ts`, read from the event classes.

## Limits

- A key that stops being live (a controller that makes `order` live only while the order is open) keeps its listeners until the next full visit. Each later event costs one reload that returns the plain value.
- Inertia's mode where an event carries the new value instead of triggering a reload is not used: the transport removes `__inertia` from every payload.
- Guren has no merge props, which Inertia does not allow to be live anyway.

## Next steps

- [Broadcasting](./broadcasting.md): channels, authorizers and the socket protocol.
- [Frontend](./frontend.md): partial reloads and deferred props.
- [Inertia Protocol Support](./inertia.md): what the server adapter implements.

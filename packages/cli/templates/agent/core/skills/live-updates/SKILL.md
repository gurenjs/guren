---
name: live-updates
description: "Make a page refresh itself when its data changes elsewhere, with live() props over the broadcast WebSocket (\"real-time\", \"live updates\", \"update without reloading\", \"show other users' changes\"). Instead of polling or a hand-written socket."
---

# Live Updates Skill

A `live()` prop reloads itself when a broadcast event says its data changed:
the browser subscribes to the event's channels on the app's own socket, and
Inertia fetches that one prop again with a partial reload. No poll, no Pusher,
no second socket server. It needs `@inertiajs/react` 3.11 or later: an older
one makes `startInertiaClient()` warn and ignore `live`, so the prop never
reloads. Check with `bunx guren deps:why @inertiajs/react` and raise the range
with `bun add @inertiajs/react@^3.11` if needed (the `dependencies` skill covers
an install the release-age gate blocks).

## Setup (once per app)

1. Broadcasting: `bunx guren add broadcasting` writes `BroadcastProvider` (the
   manager bound as `broadcast`) and registers it in `createApp()`. Skip it if
   `app/Providers/` already binds one.
2. The socket route, in `routes/broadcasting.ts`, called from the registrar in
   `routes/web.ts` (`guren check` warns on a routes file nothing calls):

   ```typescript
   import { type BroadcastManager, getRequestContainer, Router } from '@guren/core'

   export function registerBroadcastingRoutes(router: Router): void {
     router.get('/broadcasting/socket', (c, next) =>
       getRequestContainer(c).make<BroadcastManager>('broadcast').webSocketMiddleware()(c, next),
     ).name('broadcasting.socket')
   }
   ```

3. The transport, in `resources/js/app.tsx`: import it and add one key to the
   existing `startInertiaClient({ … })` call, keeping every option it already
   passes (`resolve`, `prototype`):

   ```typescript
   import { liveTransport } from '@guren/inertia-client/live'

   startInertiaClient({
     pages,
     pageManifest,
     live: liveTransport(),
     // …the options already there
   })
   ```

## A live prop

The event names the channel and pins its wire name:

```typescript
import { Event } from '@guren/core'

export class OrderUpdated extends Event {
  static override eventName = 'OrderUpdated'   // without it a bundle can rename the class and the prop never reloads

  constructor(readonly orderId: number) {
    super()
  }

  broadcastOn(): string[] {
    return [`orders.${this.orderId}`]
  }

  broadcastWith(): Record<string, unknown> {
    return { orderId: this.orderId }   // identifiers only: everyone on the channel receives it
  }
}
```

The controller passes an **instance**, never the class:

```typescript
import { Controller, live, type BroadcastManager } from '@guren/core'

return this.inertia(pages.orders.Show, {
  order: live(() => OrderResource.make(order), { on: new OrderUpdated(order.id) }),
})

// wherever the order changes; `except` skips the sender's own tab
await this.make<BroadcastManager>('broadcast').broadcastEvent(new OrderUpdated(order.id), { except: this.ctx })
```

The page component changes nothing: the prop arrives as the value it resolves to.

- `live()` is always the outermost helper: `live(defer(…))` and `live(always(…))`,
  never `always(live(…))` or a deferred callback returning `live(…)`.
- `on` takes several events: `on: [new OrderUpdated(id), new OrderCancelled(id)]`.
- `throttle` (ms, default 1000) merges bursts; a hidden tab reloads when shown.
- A private channel (`private-orders.${id}`) is authorized by
  `broadcast.privateChannel()`, as for any subscriber. The reload runs the
  controller with its middleware and policies, so a live prop never shows more
  than the page would.

## Check it

```bash
bunx guren check     # live-props:* warnings (advisory; gate does not count them)
bunx guren codegen   # .guren/channels.gen.ts lists the events broadcastEvent() sends
```

| Key | Fix |
|-----|-----|
| `live-props:socket-route` | Mount `webSocketMiddleware()` (setup step 2) |
| `live-props:event-name:…` | Add `static eventName` or `broadcastAs()` to the event |
| `live-props:outermost:…` | Move `live()` outside `always()` / the deferred callback |
| `live-props:unverifiable:…` | Write `on` as a literal `new SomeEvent(…)` of a class under `app/`, or confirm by hand |

Test the reload in a browser (the `verify-in-browser` skill): change the record
from a second tab or a request, and watch the first tab update. A test can
assert the Inertia page object's `liveProps` (per prop, the channel and event
names it listens for), not the socket.

The socket needs `app.listen()` on Bun. On Workers, Lambda, Vercel or Node the
route answers 501 and the page keeps the props it rendered.

Full guide: https://guren.dev/docs/guides/live-props.

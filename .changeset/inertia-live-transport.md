---
'@guren/inertia-client': minor
---

Add the client half of Inertia's live props (RFC 0037). `liveTransport()` from the new `@guren/inertia-client/live` entry is a transport over Guren's own `broadcast.webSocketMiddleware()` route, and `startInertiaClient({ live: liveTransport() })` hands it to Inertia, which then reloads a `live()` prop whenever one of its events is broadcast:

```ts
import { startInertiaClient } from '@guren/inertia-client/app'
import { liveTransport } from '@guren/inertia-client/live'

startInertiaClient({ pages, live: liveTransport() })
```

The transport opens one socket per tab on the first live prop and closes it a few seconds after the last one is gone (`idleTimeout`). It subscribes each channel once however many props listen on it, keeps at most 16 subscriptions waiting for an answer, and reconnects with backoff. After a reconnect it reports the connection only once every channel is subscribed again, so Inertia's catch-up reload sees the state after the subscription. It stops after five attempts that never connect, as on a runtime that cannot upgrade. It reports the socket's `socketId`, which Inertia sends as `X-Socket-Id` for `broadcastEvent(…, { except: this.ctx })`, and it removes `__inertia` from every payload, so an event can only trigger a reload. `url`, `throttle`, `pauseWhenHidden` and `webSocketFactory` are options.

Live props need `@inertiajs/react` 3.11 or later and `@guren/server` 2.36 or later. With an older Inertia, `startInertiaClient()` warns and ignores the option. A prototype build never opens a socket.

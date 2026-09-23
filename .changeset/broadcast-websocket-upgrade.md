---
'@guren/server': minor
---

`Application.listen()` passes Bun a WebSocket handler, so a route built with `upgradeWebSocket` from `hono/bun` now upgrades. Before, `server.upgrade()` threw `To enable websocket support, set the "websocket" object in Bun.serve({})` for every app served by `listen()`. Handlers still receive `{ server }` in `ctx.env`.

`broadcast.webSocketMiddleware({ getUser, allowedOrigins })` is the WebSocket counterpart of `sseMiddleware()`. It refuses with 403 a handshake whose `Origin` names another host than the request's own or an `allowedOrigins` entry, since CORS does not cover the handshake and the browser sends the app's cookies with it. Channels in `?channels=` and every `{ action: 'subscribe', channel }` message are authorized against the upgrade request's user. Frames are JSON `{ event, data }`, starting with `connected` (`{ clientId, channels }`), and each message is answered with a `subscription` event. On a runtime that cannot upgrade, the route answers 501.

`POST /broadcasting/auth` now attaches channels to a WebSocket client as well as an SSE stream, with the same ownership check against the `userId` the client was registered with. `disconnectAll()` closes WebSocket clients too and releases their driver subscriptions.

`subscribeWebSocketClient()` keeps subscribing without authorization, like `subscribeClient()`. A route that passes it a channel the client named must call `authorize()` first.

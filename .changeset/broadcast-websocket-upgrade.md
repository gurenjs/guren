---
'@guren/server': minor
---

`Application.listen()` passes Bun a WebSocket handler, so a route built with `upgradeWebSocket` from `hono/bun` now upgrades. Before, `server.upgrade()` threw `To enable websocket support, set the "websocket" object in Bun.serve({})` for every app served by `listen()`. Handlers still receive `{ server }` in `ctx.env`.

`createWebSocketOriginGuard({ allowedOrigins })` refuses with 403 a request whose `Origin` names another host than the request's own or an `allowedOrigins` entry. CORS does not cover a WebSocket handshake and the browser sends the app's cookies with it, so a socket route needs this check against Cross-Site WebSocket Hijacking. An `allowedOrigins` entry that is not an http(s) origin throws when the guard is built.

`broadcast.webSocketMiddleware({ getUser, allowedOrigins })` is the WebSocket counterpart of `sseMiddleware()`, with the same Origin check built in. Channels in `?channels=` and every `{ action: 'subscribe', channel }` message are authorized against the upgrade request's user. Frames are JSON `{ event, data }`, starting with `connected` (`{ clientId, channels }`), and each message is answered with a `subscription` event carrying the same fields as a `POST /broadcasting/auth` result. A socket with more than 32 unanswered messages is closed with code 1008, and a message over 4 KB is ignored. On a runtime that cannot upgrade, the route answers 501.

`POST /broadcasting/auth` now attaches channels to a WebSocket client as well as an SSE stream, with the same ownership check against the `userId` the client was registered with. `disconnectAll()` closes WebSocket clients too and releases their driver subscriptions. A channel repeated in `sseMiddleware()`'s `?channels=` is now authorized once and listed once in `connected`.

`subscribeWebSocketClient()` keeps subscribing without authorization, like `subscribeClient()`. A route that passes it a channel the client named must call `authorize()` first.

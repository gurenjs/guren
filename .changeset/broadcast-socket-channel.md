---
'@guren/server': minor
---

The broadcast WebSocket now names the channel on every event frame: `{ event, channel, data }`, so one socket can tell the same event apart on two channels (RFC 0037). The server's own frames (`connected`, `subscription`) keep `{ event, data }`. `WebSocketClient.send` and `SSEClient.send` gain an optional third `channel` argument, which a custom socket route may ignore.

Each WebSocket client gets a `socketId`, sent in `connected` beside `clientId` and never accepted as an input. `broadcastEvent(event, { except: this.ctx })` skips the sender's own socket: the one whose `socketId` the request names in `X-Socket-Id` and that the request's signed-in user opened. A guest, or a socket id another user's socket holds, skips nothing. `{ except: { socketId, user } }` names the two by hand. The mark travels inside the payload under `__inertia.socketId` and `__inertia.userId`, so any driver carries it. Those two fields are now reserved: `broadcast()`, `broadcastEvent()` and a channel's `broadcast()` remove them from the payload they are given, and delivery removes them before any client, WebSocket or SSE, receives the event. User ids compare strictly, so `7` and `'7'` are different users.

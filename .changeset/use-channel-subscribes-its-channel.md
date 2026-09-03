---
'@guren/inertia-client': patch
---

Make `useChannel(name)` actually subscribe to `name`.

The hook opened an EventSource on the bare SSE endpoint and attached
listeners by event name, but never told the server which channel it wanted.
`sseMiddleware()` subscribes only what `?channels=` names when the stream
opens, so `useChannel('orders')` received `connected` and `ping` and nothing
else — the channel argument was a type carrier and the documented
`feed.on('NewPost', …)` never fired.

Each subscription now opens `endpoint?channels=<name>` (`&channels=` when the
endpoint already carries a query string, the name URL-encoded). The server
authorizes the channel against the user its SSE route resolves, so private
and presence channels work through the same call when that route is given
`getUser`. `channelStreamUrl()` is exported for anyone building the URL by
hand.

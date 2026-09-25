---
'@guren/server': minor
'@guren/core': minor
---

The broadcasting middlewares resolve the session user from the auth context when `getUser` is omitted. `authMiddleware()` fell back to reading an `auth` property the request context never has, so without `getUser` every private and presence channel was refused at `POST /broadcasting/auth`; it now asks `getAuthContext(ctx)?.user()`, as `requireVerifiedEmail()` does. `sseMiddleware()` and `webSocketMiddleware()`, which authorized as a guest without `getUser`, use the same default. A guest is still `undefined` to channel authorizers, and a `getUser` you pass is used as before.

With the default, an SSE stream or WebSocket opened by a signed-in user is owned by that user, so `/broadcasting/auth` attaches a channel to it only for a requester with the same id. An app that passes `getUser` to `authMiddleware()` alone and returns a different id shape there (`{ sub: '5' }` beside a user record's `{ id: 5 }`) sees `subscribed: false`; pass the same `getUser` to the stream middleware. `@guren/core` re-exports the change.

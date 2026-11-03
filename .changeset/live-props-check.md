---
'@guren/cli': minor
---

`guren check` reports on `live()` props (RFC 0037), with advisory warnings that `--ci` and `guren gate` do not count, once a controller imports `live` from `@guren/core`:

- `live-props:socket-route`: no file mounts `broadcast.webSocketMiddleware()`, so the browser transport has nothing to connect to.
- `live-props:event-name:…`: an event a live prop listens for has no `broadcastAs()` and no `static eventName`, so its wire name is a class name a bundle can rename.
- `live-props:outermost:…`: `live()` is inside `always()` or a deferred callback.
- `live-props:unverifiable:…`: the `live()` options cannot be read.

`.guren/channels.gen.ts` now lists the events an app sends through `broadcastEvent(new SomeEvent(…))`, read from the event class in whichever file declares it: the channels `broadcastOn()` returns (a template's `${this.id}` as `{id}`), the name `broadcastAs()` or a `static eventName` gives, and the payload type of the object `broadcastWith()` returns.

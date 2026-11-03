---
'@guren/cli': minor
---

`guren check` reports on `live()` props (RFC 0037), with advisory warnings that `--ci` and `guren gate` do not count, once a controller imports `live` from `@guren/core`:

- `live-props:socket-route`: no file mounts `broadcast.webSocketMiddleware()`, so the browser transport has nothing to connect to.
- `live-props:event-name:…`: an event a live prop listens for has no `broadcastAs()` and no `static eventName`, so its wire name is a class name a bundle can rename.
- `live-props:outermost:…`: `live()` is inside `always()` or a deferred callback.
- `live-props:unverifiable:…`: the events cannot be read (options that are not literal, an event not written as `new SomeEvent(…)` of a class under `app/`, or a base class the check cannot read), reported rather than passed.

Event classes are read as `broadcastNameOf()` reads them at runtime: `broadcastAs()`, then an instance `eventName` (inherited from a base class the app declares too), then an own static `eventName`. A field with no value, `undefined` or `null` pins nothing. A class is found through the import of the file that constructs or extends it, and one imported from a package is never matched to an app class of the same name. A member that returns from more than one place is not read.

`.guren/channels.gen.ts` now lists the events an app sends through `broadcastEvent(new SomeEvent(…))`, read from the class the call's import names (an aliased import included): the channels `broadcastOn()` returns (a template's `${this.id}` as `{id}`), the name `broadcastAs()` or a `static eventName` gives, and the payload type of the object `broadcastWith()` returns.

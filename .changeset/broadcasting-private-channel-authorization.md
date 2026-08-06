---
'@guren/cli': patch
'@guren/server': patch
---

Make the generated private-channel check the check that actually runs

`make:channel --private` generated a `PrivateChannel` subclass with an
`authorize(ctx)` method, and `make:channel --presence` a `join(ctx)`. Neither
ever ran. `BroadcastManager.authorize()` resolves a channel only through the
callbacks registered with `channel()` / `privateChannel()` / `presenceChannel()`
and never calls a method on a channel instance, so both were dead code — with no
TODO or comment to say so. The presence one could not have worked in any case:
its signature contradicted the inherited `join(member)`, which is what adds an
already-authorized member.

Meanwhile the `broadcasting` blueprint registered the callback that *did* run:

```ts
broadcast.privateChannel(userFeed.getBaseName(), () => true)
```

Allow-all, on `users.{id}.feed`, next to a generated file that reads as though it
authorizes. That registration also defeats the manager's own fail-closed default,
which denies unregistered `private-`/`presence-` names.

The generated methods now take the `ChannelAuthorizer` signature
(`channelName, user`) so they can be registered, the presence hook is
`authorizeJoin()` to stop colliding with `join(member)`, and a pattern carrying
`{id}` gets an ownership check rather than a bare "is logged in". The blueprint
registers the channel's own method.

`BroadcastManager.authorize()` also normalizes its result. Callers read anything
that is not `false`/`null` as authorized, so an authorizer with an
implicit-`undefined` return path used to grant access; it now denies.

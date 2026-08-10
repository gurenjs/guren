---
'@guren/server': patch
---

Refuse requests the loopback guard cannot place, instead of allowing them

`createLoopbackGuard` protects `/_guren/mcp` and `/_guren/docs`, and it has to
stop two classes of caller: browser pages, rejected unless the `Origin` is
loopback, and non-browser clients, rejected unless the socket peer is. Both
checks were skip-on-absence — `clientAddress()` returned `undefined` when the
runtime exposes no `server.requestIP`, and each check only refused when its
signal was present. A client that sends no `Origin` (curl, any MCP client) on a
runtime that reports no peer therefore passed both. That degradation is real on
every non-Bun host and on `@guren/plugin-vercel`, which calls `app.fetch(request)`
with no environment even though Bun is present.

The peer check is now positive: a loopback peer allows, a peer that is present
and not loopback is refused as a remote request, and a peer the runtime never
reported is refused as one the guard cannot vouch for. The two denials say
different things on purpose. `bun run dev` is unaffected — `Application.listen()`
passes `{ server }` into `Bun.serve`, so the peer resolves on every request.

For a host that genuinely cannot report a peer, `GUREN_ALLOW_UNVERIFIED_PEER=1`
opts out, and the refusal names it.

A loopback `Origin` deliberately does not satisfy the peer check. `Origin` is a
negative filter — it attests that a *browser* saw a cross-site request — and any
non-browser client sets it with one flag, so accepting it as proof of locality
would leave the hole open to `curl -H 'Origin: http://localhost'`.

What the guard checks is the connection, not the caller: a reverse proxy,
container port publish, or tunnel that terminates locally presents a loopback
peer, so traffic behind it is accepted. The guides now say so, and say not to put
a tunnel in front of a dev server running with `GUREN_MCP=1`.

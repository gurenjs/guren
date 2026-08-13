---
'@guren/server': patch
---

Fix `Application` lifecycle races that could kill a live server or orphan one

`listen()` and `stop()` tracked the running server across several independent
pieces of state, and neither checked whether that state still described the
server it was acting on by the time it resumed from an `await`. Three ways that
went wrong:

**A stopped app could close a Vite dev server a newer app adopted.** On a
`bun --hot` reload the next `listen()` reuses the dev server the previous run
left listening, so both applications held the same server object. `stop()` on
the earlier one saw its own reference set and closed it — taking the asset
server, its port, and its published `VITE_DEV_SERVER_URL` out from under the
app that was serving from it. Comparing references cannot catch this: it is the
same object. The active-server slot now names one owner at a time, adoption
transfers that ownership along with the process teardown handlers, and only the
owner may close.

**A `stop()` concurrent with a `listen()` could orphan the newly bound socket.**
A graceful `stop()` waits on in-flight requests; a `listen()` arriving in that
window force-stopped the old server, bound a new one, and reused the teardown
registration. The resuming `stop()` then cleared the instance's server handle
and detached the handlers — leaving the new socket live with no way to reach it
and no signal handling. `stop()` now returns without touching anything once it
sees a `listen()` has superseded it.

**A late cleanup could clear the process-wide slot out from under a live
server.** `listen()`'s force-stop of the previous server cleared the slot
unconditionally when it finished, even if another `listen()` had already pointed
it at a server of its own. That slot is what the SIGINT/SIGTERM/exit teardown
reads, so wiping it meant the surviving socket was never closed at shutdown. The
clear is now conditional on the slot still holding the server that was stopped —
and the Vite restart cleanup guards its slot, and the published env vars that
travel with it, the same way.

**Two `listen()` calls racing could strand what the loser started.** With
nothing bound yet, both calls pass the entry force-stop, both bind, and the
later assignment overwrote the instance handle — leaving the earlier socket live
with nothing left holding it. A displaced server is now stopped instead of
dropped, and a fresh Vite dev server displaced from the slot the same way is
closed instead of stranded on its port.

Also bounds the server `stop()` itself, mirroring the existing Vite close bound:
a graceful stop that never finishes draining no longer holds shutdown open
forever. The bound defaults to 5s and is configurable through
`GUREN_BUN_STOP_TIMEOUT_MS`. A `stop` or `close` that throws synchronously is
contained like one that rejects, instead of escaping the shutdown path.

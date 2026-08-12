---
'@guren/server': minor
---

Add a public `Application.stop()` to undo `listen()`

`listen()` had no counterpart. It bound a socket, took the process-wide active
server slot, started a managed Vite dev server, and registered SIGINT/SIGTERM/
exit teardown — and the only path back out was the module-private
`stopActiveBunServer()`, which an app could reach by signalling the process or
by calling `listen()` again to replace the server, but never to simply stop.
An app could be started programmatically but only stopped by ending the program.

`await app.stop()` now closes the socket, clears the instance's server and the
managed Vite dev server, and detaches the teardown handlers. It takes the same
`closeActiveConnections` flag Bun's own `stop()` does, defaulting to `false`:
a caller reaching for a public stop is usually shutting down deliberately,
whereas the hot-reload path inside `listen()` keeps forcing the close, since a
reload must not wait on the server it is replacing. Calling it when nothing is
listening, or calling it twice, is a no-op.

Vite goes down with it. `listen()` is what started the dev server, and
`listen()`'s own bind-failure path already closes the one it started; stopping
the application while leaving the asset server up would strand it, and its
published environment variables, in a process with no application server. That
close is best-effort on the same terms as every other shutdown path — bounded by
`GUREN_VITE_CLOSE_TIMEOUT_MS`, and a dev server that overruns the bound is warned
about and abandoned rather than holding `stop()` open. `GUREN_INERTIA_ENTRY` is
now unpublished alongside the other managed variables, but only when it still
holds the entry `listen()` published; an app that set its own is left alone.

The global active-server slot is cleared only when it still points at this
instance's server, mirroring the ownership check `closeViteDevServer()` already
makes. A second `listen()` anywhere in the process force-stops the previous
server and takes the slot over, so an app that stopped afterwards would
otherwise clear a live server's teardown out from under it.

`app.address` follows from that: it reports `undefined` once stopped, and the
new address after a restart. Its documentation already treated a stop the
framework can see as clearing the address, and `stop()` is now one of those —
what it still cannot see is a caller reaching past the framework to the Bun
server's own `stop()`.

The teardown handlers are detached rather than forgotten, on both halves.
Registration was guarded by a flag that only ever went `true`, so a close that
merely reset the flag left the handlers attached while claiming otherwise, and
the next `listen()` piled on another set. `stop()` now removes them and
`listen()` re-attaches exactly one set, which is what makes an app restartable
in a single process — a restarted app with no handlers is killed by SIGTERM's
default disposition instead of shutting down through its own teardown.

The Vite dev server's handlers had the same defect and are fixed with it, which
matters more than the count: a leaked set keeps its own signal handler, and
because handlers run in registration order a stale one could call `process.exit()`
ahead of the live server's shutdown. Those handlers also captured the
`Application`, so each leaked set pinned an entire app — container, routes and
providers included. Both registrars now share one helper that attaches the
SIGINT/SIGTERM/exit trio and returns the disposer for it, so neither can drift
back to a memo that disagrees with what is actually attached.

The starter templates are unchanged: they resolve `@guren/*` from npm and
cannot call this until the release that ships it.

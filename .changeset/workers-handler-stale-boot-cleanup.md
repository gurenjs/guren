---
'@guren/plugin-cloudflare': patch
---

Stop a stale boot waiter in `createWorkersHandler` from clearing a live retry

When the first boot fails, every request awaiting that shared promise runs the
catch block, and each one dropped the boot promise and the write-once env
holder unconditionally. That is only correct for the waiter whose attempt is
still the current one.

This is a long-standing race in the boot-failure cleanup, not a regression from
the synchronous-throw fix released alongside it.

A retry can start *between* two waiters' catches: the app may attach its own
rejection reaction to the promise `boot()` returned, and reactions run in
registration order, so the reaction can sit between waiter one and waiter two.
`handler.fetch` captures the env and installs the new boot promise
synchronously, before its first `await` — so by the time the second, now-stale
waiter reaches its catch, the retry is already live. Clearing there wiped the
retry's boot promise and its env, leaving a successfully booted app with an
empty holder: `getWorkersEnv()` then threw for every subsequent request, and
the next request booted a second time.

The cleanup is now guarded by the identity of the attempt the request actually
waited on, so only its owner clears state. A synchronous throw from `boot()`
leaves both the captured attempt and the boot promise `undefined` — nothing can
interleave before that catch runs, so the guard holds and the env captured by
that same request is still cleared.

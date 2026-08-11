---
'create-guren-app': patch
---

Make the scaffolded `bin/serve.ts` honour `PORT=0` and `GUREN_STRICT_PORT=1`

`Number.parseInt(process.env.PORT ?? '', 10) || 3333` turned `PORT=0` into 3333,
so "let the OS pick a free port" — the natural way to run a scaffolded app
alongside others, or in parallel tests — could not be expressed. The parse now
tests for a number instead of for truthiness.

The entrypoint also walks to the next port when the requested one is busy, which
is a convenience for `bun run dev` and a hazard everywhere else: a smoke script,
an E2E runner, or a CI job that pins a port gets a server on a *different* port
while it keeps testing the original one — so the run passes against whatever was
already listening there. `GUREN_STRICT_PORT=1` now binds the requested port or
fails with `EADDRINUSE`. The walk is also skipped for `PORT=0`, which has nothing
to recover from and would otherwise march into the privileged range.

The generated file keeps its own retry loop rather than delegating to the
framework: templates resolve `@guren/*` from npm, so they cannot use the new
`listen({ portFallback })` option until the release that ships it. Because the
loop stays, the entrypoint now also sets `GUREN_STRICT_PORT=1` for itself before
looping — the framework walks inside `listen()` in newer versions, and a caret
range floats a scaffolded app onto one of those without any template change.
Nesting the two loops would search far past the intended range and warn about
the wrong ports; this keeps the retry in exactly one place on every version.

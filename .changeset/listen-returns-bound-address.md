---
'@guren/server': minor
---

Return the bound address from `Application.listen()`, and move the busy-port walk into it

`listen()` called `Bun.serve({ port })` and discarded `server.port`, returning
`Promise<void>`. The framework knew the port it had bound and threw it away, so
the only way to find out was to scrape the dev banner — ANSI-coloured prose
written for humans. `listen()` now returns `{ port, hostname, url }`, read off
the running server rather than echoed back from the request.

That mattered because the port asked for and the port bound are routinely
different numbers. The walk past a busy port lived in four copies of
application code (`bin/serve.ts` in both starter templates, the blog example,
and the docs site), each wrapping the framework call that should have owned it.
Copies drift, and none of them could report where the app ended up. The walk now
lives in `listen()` behind `portFallback`: `true` walks the next 20 ports,
`false` fails fast. Left unset it walks outside production, which is what the
loops it replaces did. Moving the walk inside also makes it dramatically
cheaper — a retry used to re-enter `listen()` and restart the managed Vite dev
server (~600ms per busy port); it is now a bare re-bind.

A bind that gives up now shuts the managed Vite dev server down on its way out.
`listen()` starts Vite before anything tries to bind, so an exhausted walk — or
a strict-port failure, which is precisely the case automated callers *handle*
rather than exit on — used to leave an asset server and its published
environment variables running in a process with no application server.

`GUREN_STRICT_PORT=1` forces fail-fast from outside the app. This is the case the
walk actively harms: a smoke script, a Playwright `webServer`, or a CI job that
pins a port needs to know the app answering is the one it started. Walking past a
busy port makes that failure silent and inverted — the run goes green against
somebody else's server. `bun run dev` keeps the convenience by default.

`PORT=0` also works now. `Number.parseInt(process.env.PORT ?? '', 10) || 3333`
turned 0 into 3333, so "let the OS pick a free port and tell me which" could not
be expressed — and it is the natural way to run tests in parallel. The walk is
skipped for port 0, which has nothing to recover from and would otherwise march
into the privileged range.

The starter templates keep their own loop for now: they resolve `@guren/*` from
npm, so they cannot use a `listen()` option until the release that ships it.
They do honour `GUREN_STRICT_PORT` and parse `PORT=0` correctly, which needs no
new API.

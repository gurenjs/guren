---
"@guren/core": patch
"@guren/plugin-lambda": minor
"@guren/plugin-vercel": minor
"@guren/cli": patch
---

Stub the database clients a Lambda or Vercel app does not use

A Postgres app failed to bundle for either platform with
`Could not resolve "mysql2"` — naming a database its author never chose — and
`@aws-sdk/client-rds-data` behind it. `@guren/orm` names each dialect's client
in a *literal* dynamic import, and a bundler follows those whether or not the
branch can be taken, so every client the app did not install broke the build.

Workers could stub all of them, because D1 is the only database there is.
Here the client the app *does* use is load-bearing, so the build now reads
which dialects `config/database.ts` declares and stubs only the rest.
Detection is a union, never a single answer — an app legitimately pairs
Postgres with sqlite and picks at runtime — and it fails open: when no
factory can be read, nothing is stubbed and the build says so. Over-stubbing
would ship a function that builds clean and cannot reach its own database,
which is a far worse failure than the loud one this replaces.

Pass `databaseDialects` to `buildLambdaOutput`/`buildVercelOutput`, or
`guren lambda:build --database postgres,sqlite`, for an app whose config
reaches a factory without naming it.

`buildVercelOutput` is now **async**. It bundled by spawning `bun build`,
whose CLI has no way to replace a module — no alias flag, no plugin flag — so
this platform had no stub mechanism at all. It now uses Bun's JS API, which
takes plugins. Update `scripts/vercel-build.ts` to `await buildVercelOutput({
... })`; the scaffold emits that from now on.

That missing mechanism was also why a scaffolded app could not be bundled for
Vercel at all: the disabled MCP endpoint's `import("@guren/cli")` resolves and
the CLI's own `import("@guren/openapi")` behind it does not. The Vercel build
now stubs the same dev-only modules Lambda has stubbed since it shipped —
Vite and the MCP endpoint — which also drops the dev tooling those dragged
into the function. `bun:sqlite` is deliberately **not** stubbed here: the
function runs on Vercel's Bun runtime, so sqlite is a working database on this
platform, unlike on Workers and Lambda.

Both plugins also pass `throw: false` to `Bun.build`: it rejects with a bare
"Bundle failed" by default, discarding the one line that matters — the module
it could not resolve.

An opt-in `GUREN_TEST_BUNDLE=1` test per platform bundles a Postgres app with
no other client installed. Each installs the ORM from a tarball rather than a
local path, because a linked install resolves out into this repository's own
`node_modules` where every client exists. The assertions are behavioural
rather than about the stub's text: resolution happens before dead-code
elimination, so the message a stub throws is not in the output either way.

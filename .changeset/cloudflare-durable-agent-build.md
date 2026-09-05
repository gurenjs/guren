---
'@guren/plugin-cloudflare': minor
---

Generate the Durable Object half of a worker for apps hosting agents (RFC 0017 Part 2b)

`guren cloudflare:build` now reads `config/agents.ts` and produces a worker that
can actually host the agents an application registers. Nothing changes for an
app without that file: its generated worker and scaffolded `wrangler.jsonc` are
byte-for-byte what they were.

- **A shared boot primitive.** `bootWorkersApp(app, env)` and
  `bootAndFetch(app, request, env, ctx)` are exported from the package root, and
  `createWorkersHandler(app)` is built on them — it now returns a `boot(env)`
  alongside `fetch`. An agent woken by an alarm has an `env` but no request, and
  before this it would have reached an unbooted application. The latch is keyed
  on the app (a `WeakMap`), so one process may boot several applications while
  one isolate still boots its own exactly once, from whichever entrypoint
  arrives first.
- **Named-export injection.** For each registration the generated worker gains
  an `export { Class } from '…'` line, registers
  `configureAgentRuntime((env) => handler.boot(env))` at module scope, and
  default-exports an entry that boots, offers the request to the agent router,
  and otherwise dispatches to the application. With `--mcp-oauth` the OAuth
  provider's `defaultHandler` is that same entry and both halves share the one
  handler, so there is still a single boot slot.
- **`/agents/*` is deny-all.** The mount goes through
  `routeGuardedAgentRequest`, which refuses every request — HTTP and WebSocket
  upgrade alike — with 403 until `config/agents.ts` declares
  `routing.authorize`. The refusal happens in the SDK's pre-dispatch hook, so no
  Durable Object is constructed and none pays a cold start. The build says so
  once, at generation time.
- **Bindings verification.** A registered class with no `durable_objects`
  binding, or one that is not SQLite-backed, fails the build *before* the app
  build runs, with the exact JSON to add. Both forms wrangler accepts are
  recognised: the legacy `migrations` list, read as *history* (a class created
  in `v1` and deleted in `v2` is gone; a rename carries the backend), and the
  declarative `exports` map. Every named environment is verified on its own,
  since wrangler does not inherit `durable_objects` into one, and a binding with
  a `script_name` counts for neither hosting nor routing. The bindings the
  config gives the registered classes become the generated worker's routing
  allowlist. A fresh scaffold gets the legacy form written for it — that is
  what the agents SDK documents and what the workerd test lane runs. An
  unparseable config warns that the check was skipped rather than passing
  silently.
- **Refusals before the build.** An app registering agents without
  `@guren/plugin-agents` under `dependencies` is refused, as are a registration
  with no usable `module`/`export`, a module outside the app, an export name
  that is not a class name (`default` included), two registrations claiming one class, two
  classes whose names scaffold one binding (`HTTPAgent`/`HttpAgent`), a
  `routing` block with no callable `authorize`, and a `wrangler.jsonc` with
  `"minify": true` — wrangler's minifier renames the class an agent looks itself
  up by. A registry that cannot be evaluated on Bun fails naming the file rather
  than with a bare module-resolution trace.

One behaviour note: RFC 0017 §6 asked for `captureWorkersEnv` to treat a second,
different `env` object as a hard error. It does not, and the reason is measured
rather than assumed — on workerd a Worker entrypoint and a Durable Object of the
*same* deployment are handed different `env` objects (two Durable Objects share
one), so identity is not a test for "another environment" and the refusal would
break the two-entrypoint topology it was meant to protect. First-capture-wins is
unchanged; the per-app boot latch is what keeps one isolate on one application.

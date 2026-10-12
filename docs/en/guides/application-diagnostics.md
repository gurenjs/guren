# Application Graph and Runtime Errors

These commands report how a running app is wired and which server errors it hit, for you and for coding agents. They are development tools: the endpoints exist only while the dev server runs.

Use `graph` to read the routes, controllers, models, Inertia pages, middleware,
validators, policies and tests that Guren can identify, together with the
evidence for their relationships:

```bash
bunx guren graph --json
bunx guren graph --json --no-introspect
```

The JSON includes `schemaVersion`, `snapshot`, `nodes`, `edges`, `unresolved`
and `coverage`. The schema ships at
`node_modules/@guren/cli/assets/application-graph.schema.json`. IDs distinguish
source files and modules. Duplicate routes keep separate IDs and registration
order. A relationship based only on a matching name stays unresolved.

Default collection registers the application in an isolated process without
booting it. It also imports controller, bound-model and validator files to match
class and schema identities; top-level application code still runs.
`--no-introspect` reads source only. Registered routes, middleware and the
relationships that start at a route (`handles`, `binds`, `usesMiddleware`,
`tests`) are then unavailable, and `validates` and `authorizes` keep only their
source half as partial coverage. Existing `context` and `check` commands retain
their import behavior.

Each relationship comes from a reader other commands already use:

- `handles`, `binds` and `usesMiddleware` come from registered routes. A
  middleware node is an alias or group the router registers. Inline middleware
  has no identity, since two handlers can share a function name, so it stays
  unresolved. Middleware added with `app.use()` is not part of a route's chain
  and does not appear.
- `validates` links a controller to the validator export it passes to
  `validateBody()`, `validateQuery()` or `validateParams()`, and a route to the
  validator export its `params`, `query` or `body` contract schema is. A schema
  declared outside the validator files, in the controller file for example,
  stays unresolved.
- `authorizes` links a controller to a policy class its action imports and
  names. `this.authorize()` and `this.can()` reach a policy through the
  `gate.policy()` binding a provider makes at boot, which the graph does not
  run, so those calls stay unresolved with the policy named after the model as
  a candidate. Authorization middleware is reported the same way.
- `tests` links a test file to each route its `TestApp` requests reach, read the
  way `plan:render` reads them for Impact. A request found is not a test passed.
  A request no registered route answers is listed as unresolved without making
  the section partial.

An absent optional directory is empty; unreadable or unsupported source is
reported as partial coverage. With an older server, model bindings without
identity information remain unresolved.

A complete, stable graph exits 0. Partial coverage, unavailable sections or source
changes during collection exit 1 **with the graph still on stdout**. An
application that authorizes through the gate or uses inline middleware exits 1
for that reason, so consumers should parse the JSON even then.
A collection or output-limit failure instead returns
`{ "schemaVersion": 1, "error": { "code": "…", "message": "…" } }`.
Graph output is limited to 8 MiB.

The snapshot hash includes graph content and source fingerprints, excluding the
capture time. A fresh read observes uncommitted edits. Files read from the project
are compared before and after registration; a change sets
`snapshot.consistency` to `changed`. Dependencies, dotfiles and generated build
directories are outside this source comparison. This is not a filesystem
transaction or evidence that a test passed.

To read failures from the running development application, enable its existing
MCP endpoint and address the origin it reports:

```bash
GUREN_MCP=1 bun run dev
```

From another terminal:

```bash
bunx guren runtime:errors --json --url http://127.0.0.1:3333
bunx guren runtime:errors --json --url http://127.0.0.1:3333 --limit 100
```

Replace the port with the bound port. The client accepts an explicit HTTP
loopback origin, rejects credentials and redirects, and times out after five
seconds. The endpoint retains the MCP peer/origin guard, including its existing
explicit `GUREN_ALLOW_UNVERIFIED_PEER` override. Production never enables
collection.

Coding agents can use `guren_get_application_graph` and
`guren_get_runtime_errors` through `/_guren/mcp`. The latter reads the same data
as `/_guren/runtime/errors` and the CLI. Pass `nextCursor.sessionId` as
`--session` and `nextCursor.after` as `--after` on subsequent CLI reads. MCP takes
`sessionId`, `after` and `limit` directly. The default limit is 20, with a maximum
of 100.

Each application retains at most 100 server-error events for 15 minutes, bounded
by 8 KiB per event and 256 KiB total. Events contain the exception's HTTP status,
method, a registered route when identifiable, and existing project-relative
stack locations. They omit exception messages, request values, headers, cookies
and raw stack text. A custom renderer can return a different response status.
A model/controller relation in the graph does not prove authorization.

`status: "unavailable"` means collection could not be read; it is distinct from
an available empty feed. `dropped` reports discarded events, and `cursorExpired`
reports a cursor outside retained history or from another session. Stopping the
application clears its buffer and changes the session ID. Custom error handlers
that bypass Guren's exception handler, excluded exception classes, browser
errors, logs, background jobs and failed tests are outside this feed.

`guren_get_plans` lists the implementation plans the docs viewer shows: every
plan not closed at its current hash, including drafts nobody has approved yet,
with its approval, each step with the outcome its last `plan:verify` recorded,
waivers, and the next command. `active` names the step `plan:next` marked in
each plan, with its `stall` once the Stop hook gave up on it, and `unreadable`
names plan directories that would not list (app-relative, `.` for the app root,
with the error), the same ones the docs viewer shows above its plan list. The tool reads plan files and `.guren/plans/` only, so it runs
no verification and never imports the application. Run `plan:status` for the
state of each planned element.

Continue with [implementation plans](./implementation-plans.md) to compare
planned work against the application's existing verification rules.

## Dev Center

Start the development server with the MCP endpoint enabled, then open
`http://localhost:3333/_guren` (use your app's port):

```bash
GUREN_MCP=1 GUREN_DOCS=1 bun run dev
```

The Dev Center displays the same application graph as `guren graph` and the
same retained errors as `guren runtime:errors`. Select a route to inspect its
related symbols and evidence, or filter by symbol kind, name, file or module.
Coverage and unresolved relationships remain visible when a reader cannot
establish a relationship. A snapshot marked as changed needs another read.

The page reads once when opened. **Refresh graph** starts a fresh scan, which
can import application modules as described above; **Refresh errors** replaces
the displayed retention window. Neither button runs verification commands.
A failed read shows unavailable data and clears the previous result. An empty
error window means no retained exceptions, not that the application is healthy.

**Docs & plans** opens the existing docs viewer at `/_guren/docs`, including its
plan views. That viewer requires `GUREN_DOCS=1`. The Dev Center itself requires
`GUREN_MCP=1` and uses its peer/origin guard; it is disabled in production.
Older CLI versions without the page factory keep their existing MCP tools but
do not mount the Dev Center. Upgrade Guren if `/_guren` returns 404.

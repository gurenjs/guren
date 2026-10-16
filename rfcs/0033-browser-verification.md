# RFC: Browser Verification for the Agent Harness

**Author:** Guren contributors
**Date:** 2026-10-14
**Status:** Accepted (2026-10-15; the deciding maintainer asked for implementation to start
and shortened the standard discussion period.)

## Problem

A coding agent working in a Guren app can prove a change at the HTTP level and
no further. `plan:verify` runs `TestApp` tests that request a route and assert
the status, the redirect, the Inertia component name and database rows. The
Stop hook and `guren gate` judge the same evidence. Nothing in the harness ever
drives a rendered Inertia page in a browser, so a class of defects passes every
gate:

- a form field whose `name` is not the key the validator reads, so the 422
  lands on a field the page never shows;
- a submit button posting to the wrong route, or a link to a route that needs a
  parameter the page does not pass;
- a page that throws while rendering props the controller sends, when the types
  agree but the value does not (the deferred-prop check in `guren check` catches
  one such case statically);
- a failure state the page has no branch for, such as a 500 that leaves the user
  on a form with no message.

The agent also has no recipe for looking. Each session works out again how to
start the app and on which port, which database is safe to write to, which
account signs in, and where to keep screenshots. Starting the app is less
obvious than it looks: `bin/serve.ts` walks forward from a busy port, the
development banner is decorative and can be suppressed (`GUREN_DEV_BANNER=0`),
`PORT=0` fails env validation (`Env.port()` accepts 1 to 65535), and which
database the process connects to depends on `NODE_ENV` as well as
`DATABASE_URL` (the SQLite scaffold reads `TEST_DATABASE_URL` under `test`).
Scaffolded apps ship no browser tests; only `examples/blog` has a Playwright
suite.

Prior art: the `create-verification-skill` skill in tester-army/e2e has an agent
interview the repository and write a project-local `verify-<app>` skill with a
launch recipe, a read-only doctor, a feature map with one exploration charter per
feature, evidence rules and a bug-bash loop. The structure fits the gap above.
Most answers to its interview are things Guren already computes: routes, the
pages controllers render, middleware, acceptance criteria. An agent
reconstructing them from source is slower than reading them and can disagree
with the framework's own readers.

### Existing implementation to reuse

| Capability | Source | Use here |
| --- | --- | --- |
| Application Graph (RFC 0032) | `packages/cli/src/application-graph*.ts`, `guren graph --json` | Route → controller (`handles`), controller → page (`renders`, with the action in the edge's `controller:<action>` evidence), `usesMiddleware`, `tests`, per-section coverage, `unresolved`, stable/changed snapshots |
| Runtime errors (RFC 0032 §4) | `guren runtime:errors`, `packages/server/src/mcp/runtime-errors.ts` | Session and sequence cursors with paging, eviction and expiry reporting; active only with `GUREN_MCP=1` outside production |
| Introspection (RFC 0026) | `packages/cli/src/introspect.ts` | Registration-only manifest; the place a database description belongs (§3) |
| Plan views and acceptance (RFC 0030) | `PlanViewSchema`, `AcceptanceSchema` in `plan/schema.ts`; `readPlanApprovalStanding()` in `plan/approvals.ts` | View ids, field keys and labels, action labels and routes, page states |
| Marker blocks | `packages/cli/src/plan/close-docs.ts` | Regenerate derived sections of a committed document without touching author text |
| Harness distribution | `templates/agent/core/skills/`, `agent-targets.ts` | A new canonical skill is discovered and shipped to every target with no list to edit |
| Playwright setup | `examples/blog/playwright.config.ts`, `e2e/` | `reuseExistingServer: false`, a setup project for sign-in; its server is `bun run dev` locally and `bun run e2e:server` in CI |

## Proposed Solution

### 1. Scope

This RFC adds four CLI commands, one manifest section, one harness skill and
one opt-in blueprint that puts a new devDependency into the app. It changes no
gate.

| Addition | Package | Needs a browser |
| --- | --- | --- |
| `database` section in the introspection manifest | `@guren/server`, `@guren/orm` | No |
| `guren browser:map` writes and refreshes the feature map | `@guren/cli` | No |
| `guren browser:serve` starts one instance under the safety rules | `@guren/cli` | No |
| `guren browser:doctor --url` checks that an instance is worth driving | `@guren/cli` | No |
| `guren browser:record` writes the evidence of a verification run | `@guren/cli` | No |
| `verify-in-browser` skill | harness template | Uses one when available |
| `guren add browser-tests` | `@guren/cli` blueprint | Installs `@playwright/test` into the app |

The commands and the manifest section are new public surface, and the blueprint
adds a runtime requirement (a browser binary) to apps that opt in, which is why
this is an RFC rather than a template change. The map and doctor read
`loadApplicationGraph()` and RFC 0030 plans. A fact the graph does not carry is
a gap to fix in the graph, not a second reader here.

The `browser:` namespace keeps the word "verify" for RFC 0030, where `verified`
is a recorded state. A browser run never produces one.

### 2. The feature map

`guren browser:map` writes `docs/browser/README.md` (an index) and one
`docs/browser/<feature>.md` per feature. The files are committed: they are the
project's maintained description of how a user reaches each feature and what
proves it works.

**Features.** A feature is the first path segment of a page under
`resources/js/pages/` (`pages/posts/Index.tsx` is `posts`); a page directly under
`pages/` is its own feature. This is the only grouping rule. Module pages live
under the root `pages/<module>/…` tree and group the same way. ~~The graph records
no module for a page today, so the map claims none~~ **Amended in
implementation:** the graph records a page's module only for a page file under
`modules/<name>/`, which the map prefixes to the feature name; it infers no
module for the root tree. Further module ownership is added to
the graph first if a later version needs it (Open Question 2).

**Joining routes to pages.** The `renders` edge runs from a controller class to
a page and records the action in its evidence. The map joins on the action: a
route belongs to a feature when its `handles` edge reaches a controller whose
`renders` evidence names the route's action and a page in that feature. An
action rendering pages in two features lists the route under both, each marked
as one of several possible renders; none is chosen. A route whose action renders
nothing (a `store`, a `destroy`) belongs to the feature only when every page its
controller renders is in that feature; otherwise it is listed in the index as
unassigned with the candidates. A page no route reaches is listed as unreached.

**Coverage.** The map is complete only when the graph's ~~`routes`, `handles`,
`renders` and `pages`~~ coverage is complete and the snapshot is stable.
**Amended in implementation:** the graph's keys are `route`, `controller`,
`page`, `handles` and `renders`; a gap in `usesMiddleware` is noted in each
feature's reach section instead, since it shortens a middleware list but not the
feature set. Otherwise ~~every file states~~ **the index states** that the
feature set may be incomplete, with the graph's reasons, and `browser:map` exits
1 after writing. Feature files carry no snapshot-dependent text, so `--check`
does not fail on an unrelated source edit. An `unresolved` render is printed
with its reason, never guessed.

**Generated and authored sections.** Each file carries OKF frontmatter
(`type: browser`; `entities` only for models the graph binds to a feature's
routes), written when the file is created and never touched afterwards, as
`plan:close` treats an existing document's frontmatter. `check --docs` reads
`docs/` and will check these files like any other
document, so the generator writes only references that resolve. Sections the
command owns sit between markers and are replaced on every run; everything else
belongs to the author:

```markdown
## Routes
<!-- guren:browser routes -->
| Method | Path | Name | Middleware | Page |
| --- | --- | --- | --- | --- |
| GET | /posts | posts.index | | posts/Index |
| POST | /posts | posts.store | auth | |
<!-- /guren:browser routes -->

## Charters
(author-owned; seeded once, then kept)
```

The marker reader is the one `plan:close` uses, generalised to take the marker
name; markers it cannot rewrite safely (unclosed, duplicated, inside a fence)
refuse the run with nothing written.

| Section | Owner | Source |
| --- | --- | --- |
| Routes | generated | the join above, middleware from `usesMiddleware` |
| How to reach it | generated | the landmark route (first parameterless GET) and its middleware names, as the graph records them |
| Plan | generated when a plan covers it | see the mapping below |
| Charters | author | seeded once from acceptance kinds; kept afterwards |
| Gotchas | author | none |

**Mapping from a plan.** A plan `readPlanApprovalStanding()` reports approved,
closed or not, contributes to the features its routes land in. Drafts are not
read. What a plan states is printed as planned; the skill confirms it against
the live page before a spec relies on it.

| Plan field | Map line |
| --- | --- |
| `acceptance.actor`, `given` | prose describing the starting account and state; provisioning is the author's |
| `acceptance.route`, `input` | the route a drive must submit to and the values to submit |
| `expect.redirect` | the path the browser must land on |
| `expect.inertia` | resolved through the plan's `views` to the page the browser must land on |
| `expect.errors` | the field keys that must show an error; the message text is not planned |
| `expect.database` | the rows to check after the drive |
| `views[].form.fields[]` | field key, input kind and label; locate by label |
| `views[].actions[]` | label and route; the role (button or link) is left to the live page |
| `views[].states` | the states a bug bash must reach |
| `acceptance.kind` | one seeded charter per kind |

A feature no plan covers gets routes and reach only, and its Plan section says
"none"; outcomes are not inferred from names (RFC 0032's rule for name-only
relations).

`browser:map --json` prints the model the files are rendered from.
`browser:map --check` exits 1 when a generated block differs from what a run
would write, and writes nothing. **Amended in implementation:** it also exits 1
on an incomplete map or an unread plan, as a writing run does, so a matching
document never passes a check the map itself fails.

### 3. Launching: the `database` manifest section and `browser:serve`

**The database the app will use.** No CLI check can learn the effective
connection from env variables alone: `NODE_ENV` chooses between variables, and a
custom resolver can ignore all of them. The introspection manifest gains a
`database` section, computed in the introspection child from the bound database
config without connecting:

```ts
interface ManifestDatabase {
  dialect: 'postgres' | 'mysql' | 'sqlite' | 'd1' | 'unknown'
  location: 'local' | 'remote' | 'unknown'
  reason?: string
}
```

`local` is a loopback host, a SQLite file or `:memory:`. The orm's built-in
factories report their resolved target through an optional `describe()` on the
configurable database, evaluated under the same env and `NODE_ENV` the server
will run with. A database bound without `describe()`, a resolver it cannot
evaluate without side effects, or any parse failure is `unknown`, and RFC 0026
§5's fallback rule marks the section unverified.

**`guren browser:serve [--port <n>] [--json]`** starts one instance for a
verification session and stays in the foreground until stopped. It is the only
launch the skill and the blueprint use, so every launch passes the same checks:

1. Refuse when `NODE_ENV` is `production`. Use the process's `NODE_ENV` as given;
   the manifest is read under the same value.
2. Introspect, and refuse unless `database.location` is `local`. `--database-url`
   overrides `DATABASE_URL` for the child only, and the check runs again on the
   result; `unknown` is a refusal, never a pass.
3. Run `guren codegen`, as the scaffold's `dev` script does, so generated imports
   exist. It writes only generated files.
4. Pick a free port when none is given, then spawn `bun bin/serve.ts` with that
   `PORT`, `HOST=127.0.0.1`, `GUREN_STRICT_PORT=1` and `GUREN_MCP=1`. A busy port
   fails the start instead of walking to the next one.
5. Ready when an HTTP request to the origin answers, within a timeout
   (default 60 s). No banner is parsed.
6. Print `{ origin, pid, collector }` as one JSON line, then forward the child's
   output. On SIGINT or SIGTERM, stop the child it spawned and nothing else.

Port selection races another process between probe and bind; strict mode turns
that race into a failed start rather than a server on the wrong port.

**Amended in implementation:**
- Codegen (step 3) runs before introspection (step 2): a fresh clone's entry
  imports generated files, so introspecting first refuses every fresh clone.
- An app that binds no database through `defineDatabaseConfig()` is refused
  too, since nothing shows where its data lives.
- There is no `--json`: the JSON line is the only stdout output, and the
  child's output goes to stderr. `--timeout <s>` sets the readiness wait.
- A stop this process asked for exits 0; the app ending on its own is a failure.
- `GUREN_STRICT_PORT` covers the app's port, not the Vite dev server's, which
  picks its own.
- A refusal reason never echoes the connection setting: the SQLite driver's
  own refusal names the value, which may carry a password.
- ~~No banner is parsed~~ (step 5): an HTTP answer alone can come from a
  stranger already on the port, which would hand out an origin whose database
  was never judged. The port is first checked free on 127.0.0.1 (a busy
  `--port` refuses), and the app is ready only once its own dev banner reports
  binding that port (`GUREN_DEV_BANNER=1`, colours off) and it then answers.
- Signal handling starts at the spawn, not at readiness: SIGINT, SIGTERM and
  SIGHUP stop the app's process group (a second one kills it) and this
  process's exit kills it, so a signal during boot leaves nothing running. A
  SIGKILL of this process still orphans the app; nothing can catch it.
- `NODE_ENV` is passed explicitly (the caller's, else `development`), so the
  app's own `.env` cannot serve under another value than the one judged.
- `GUREN_BROWSER_SEED` is not set yet; it arrives with the seeder that reads it
  (§6).

### 4. The doctor

`guren browser:doctor --url <origin> [--json]` answers one question before an
agent spends a browser session: does this instance serve the mapped landmarks
without a server failure? It starts nothing. The origin must be loopback HTTP
with no credentials, as `runtime:errors` requires; no redirect is followed.

**Per feature:**

1. GET the landmark route. A 200 is checked further. A redirect on a route whose
   middleware includes an authentication alias is reported `auth-required` with
   its `Location`, and its page is not compared. Any other status fails.
2. On a 200, read the initial page object from the `<script data-page>` element
   and compare its `component` with the page the action-aware join (§2) names.
   Two candidate pages pass on either and say so.
3. Before the first request, read `runtime:errors` to the end and keep the
   high-water cursor. After the last request, drain every page from that cursor.
   An event correlated to a mapped route fails that feature; an uncorrelated one
   fails the run. A changed session, an expired cursor or a dropped count that
   grew makes the window `inconclusive`. An unavailable collector makes it
   `unavailable` (RFC 0032: not zero errors).

**Result.** `pass` requires every feature `pass` or `skipped`, at least one
`pass`, a complete map (§2) and an available, conclusive error window. A
landmark needing a parameter is `skipped`; `auth-required` is neither pass nor
fail. A run with no feature passing, an incomplete map, or an inconclusive
window is `inconclusive`. Exit 0 only on `pass`.

`--evidence <run>` also writes the report as `doctor.json` into that run's
directory (§7); without it the doctor writes nothing.

**Amended in implementation:**
- Which routes require a signed-in user is read from the graph: each route node
  carries `authentication` (`required` or `guest-only`), folded from the
  registered middleware's capabilities, inline middleware included. A redirect
  is `auth-required` only on a `required` route; any other redirect fails. As
  §4's Result sentence says, an `auth-required` landmark keeps the run from
  `pass` (Open Question 7 is how it could be checked signed in).
- `--evidence <run>` arrives with `browser:record`, which owns the run
  directory (§7).
- The map is built without plans (only landmarks and completeness matter
  here), and a request that cannot connect fails its feature.

**What it does not prove.** In `default-ssr` apps the GET also renders on the
server. An SSR failure is logged and falls back to client rendering with a valid
page payload and a 200, outside the exception handler, so the collector never
sees it. The doctor claims HTTP and page-payload health, not the absence of
rendering failures (Open Question 6).

### 5. The `verify-in-browser` skill

`templates/agent/core/skills/verify-in-browser/SKILL.md` ships to every target
through `agent:init` and `agent:sync`. It is a recipe, not a generator: the
app-specific facts live in the map, so the skill is identical in every app.

- **Read first:** `docs/browser/README.md`; run `browser:map` if it is missing
  or `browser:map --check` fails.
- **Launch:** one `browser:serve` for the whole session, in the background; keep
  the origin it prints. Every later step uses that origin.
- **Doctor:** `browser:doctor --url <origin>`; on anything but `pass`, fix the
  server or report the inconclusive reason before opening a browser.
- **Drive, scripted:** when `@playwright/test` is installed, a spec under
  `tests/browser/` using the map's locators after confirming them on the live
  page; the default on every target, since it needs only a shell.
- **Drive, live:** only when the client already exposes browser tools (Claude
  Code's browser, a Chrome DevTools or Playwright MCP server). The skill never
  installs or registers an MCP server.
- **Proof standards:** drive the user's path, not a test-only endpoint; capture
  the action and the resulting state; check planned database rows; keep a
  runtime-error window (§4, step 3) around each step.
- **Evidence:** open a run with `browser:record --begin` after the doctor, and
  wrap every step in `browser:record --step <id> --open` and `--close` (§7). The
  skill never writes `run.json` by hand.
- **Bug bash:** charters come from the map. A finding is reported as a bug only
  once a spec in `tests/browser/` fails on the assertion that states it.
- **Cleanup:** stop the `browser:serve` it started; never kill by process name;
  leave the evidence.

Files touched: the skill itself (discovered with no list to edit), the skill
references in `core/entry-body.md` and `rules-catalog.md`, the two workflow
fragments that name skills (`targets/claude/workflow.md`,
`targets/agents/workflow.md`), and the harness tests.

### 6. `guren add browser-tests`

An opt-in blueprint, since it adds a devDependency and a browser download:

- `@playwright/test` as a devDependency and `test:browser` in `scripts`;
- `playwright.config.ts` whose `webServer` runs `guren browser:serve --port
  <fixed>` with `reuseExistingServer: false`, so every Playwright launch passes
  §3's checks and never attaches to a server it did not start, and
  `gracefulShutdown: { signal: 'SIGTERM' }`: Playwright otherwise SIGKILLs
  `browser:serve`'s process group, which the app's own group survives;
- `tests/browser/smoke.spec.ts`, one test per mapped landmark;
- when the app has auth (`make:auth`'s users table and login route), a setup
  project that signs in once and a seeder `db/seeders/browser-account.ts` that
  does nothing unless `GUREN_BROWSER_SEED=1` is set and `NODE_ENV` is not
  `production`. The guard is in the seeder because `db:seed --force` and
  boot-time seeding both bypass the CLI's production refusal. `browser:serve`
  sets the flag only for its child; the password comes from
  `BROWSER_TEST_PASSWORD` (declared in `.env.example`, never written to a file
  the blueprint creates);
- `_gitignore` lines for `test-results/`, `playwright-report/` and
  `tests/browser/.auth/`.

The blueprint refuses an app `app-surface.ts` identifies as API-only. An app it
cannot classify is not refused.

### 7. Evidence

A run is one verification session against one origin. Its evidence goes under
`.guren/browser/<run>/`, where `<run>` is a UTC timestamp and the feature
(`2026-10-15T10-42-07Z-posts`). `.guren/browser/` carries its own `.gitignore`
as `.guren/plans/` does.

```text
.guren/browser/<run>/
├── run.json             # the run and its steps, written only by browser:record
├── doctor.json          # browser:doctor --evidence <run>
├── runtime-errors.json  # every event drained during the run's steps
├── spec-report.json     # Playwright's JSON reporter, when a spec ran
└── screenshots/         # files a step names
```

**Writers.** Every file has one writer, and the agent writes none of them by
hand except screenshots:

| Command | Writes |
| --- | --- |
| `browser:record --begin --url <origin> --feature <name>` | creates the run, `run.json` with origin, graph snapshot id, commit (and whether the tree is dirty), feature; prints `{ run }` |
| `browser:doctor --url <origin> --evidence <run>` | `doctor.json` |
| `browser:record <run> --step <id> --open` | takes the runtime-error high-water cursor for the step |
| `browser:record <run> --step <id> --close --input <file\|->` | drains the window from that cursor, appends its events to `runtime-errors.json`, checks every named screenshot exists under `screenshots/`, appends the step to `run.json` |
| the blueprint's Playwright config | `spec-report.json`, when `GUREN_BROWSER_RUN=<run>` is set |

`--close` refuses a step that was never opened, a screenshot outside the run
directory, and an input field it does not know.

**The step record.** Each field says who established it: `cli` for what
`browser:record` measured, `recorder` for what the agent or a spec reported.
A reader never mistakes an agent's account of the page for a measurement.

```ts
interface BrowserStep {
  id: string                      // an acceptance id, or a charter slug
  result: 'pass' | 'fail' | 'inconclusive'
  action: string                  // recorder: what was done, in the map's terms
  landed?: { url: string; component?: string }   // recorder
  errorsShown?: string[]          // recorder: field keys with a visible error
  database?: Array<{ table: string; has?: unknown; missing?: unknown; found: boolean }>  // recorder
  screenshots: string[]           // cli: checked to exist, with sha256
  runtimeErrors: {                // cli
    from: string; to: string; events: number; dropped: number
    window: 'conclusive' | 'inconclusive' | 'unavailable'
  }
}
```

`result` is the recorder's verdict, except that the CLI lowers it: any runtime
event in the step's window makes it `fail`, and an inconclusive or unavailable
window makes a `pass` `inconclusive`. Nothing raises it. Guren has no database
reader for browser runs (RFC 0032 keeps SQL execution out of scope), so
`database` is what the recorder observed, through the app's own models or a
spec; it is labelled as such rather than checked.

Gitignoring stops tracking, not leaking, so what may be written there is fixed:

| Kept | Not kept |
| --- | --- |
| doctor and spec reports (JSON) | Playwright storage state (`tests/browser/.auth/`) |
| screenshots named by step | traces and HAR files, unless the user asks; they carry cookies and request bodies |
| runtime-error events (already redacted by RFC 0032 §4) | request bodies, headers, cookies, env values |

Screenshots can show whatever the page shows, including seeded data. The rule is
that Guren writes no credential into a file it generates or an evidence report;
it does not claim a screenshot is free of secrets.

### 8. Relation to gates

Browser results are advisory. `plan:verify`, the Stop hook and `guren gate` do
not read Playwright results or `.guren/browser/`, and no acceptance criterion is
satisfied by a browser run. `docs/browser/` is ordinary documentation: `guren
check --docs` validates it like any other file, which is why the generator
writes only resolvable references. A browser in a gate changes what CI needs and
how often it flakes; that decision is deferred to M4.

A step record names an acceptance id, but no plan command reads it: `plan:status`
shows nothing about a browser run, and `plan:close` does not cite one. Whether a
plan should at least point at the latest run for an id is Open Question 8.

### 9. Delivery

| Stage | Deliverable | Done when |
| --- | --- | --- |
| M1 | `browser:map` ~~and the skill~~ | The map round-trips on `examples/blog` and a `make:feature` app; author text survives; an incomplete graph is reported, not hidden |
| M2 | `database` manifest section, `browser:serve`, `browser:doctor`, `browser:record`, **the skill** | §3, §4 and §7 rules hold in fixtures, including `NODE_ENV=test` on the SQLite scaffold and a custom resolver reading `unknown` |
| M3 | `add browser-tests`, specs from plan views | A scaffolded app with one approved plan gets a spec whose locators resolve on the live page |
| M4 | Gate decision | Measured flake rate and CI cost on the golden-path smoke decide whether an acceptance may require a browser run |

**Amended in implementation:** the skill moved from M1 to M2. Its launch, doctor
and evidence steps name `browser:serve`, `browser:doctor` and `browser:record`;
shipped before them, it would either point at commands that do not exist or
launch the app without §3's checks.

### 10. Acceptance

- A route whose action renders `posts/Index` lands in `posts`; another action of
  the same controller rendering `admin/Posts` lands in `admin`; a controller
  route rendering nothing, whose controller renders pages in both, is listed as
  unassigned with both candidates.
- An unresolved `renders` edge is printed with its reason and never guessed; a
  partial graph makes `browser:map` exit 1 with the reasons in every file.
- A rerun of `browser:map` is byte-identical; text outside markers survives;
  broken markers refuse with nothing written; generated files pass
  `check --docs`.
- `browser:serve` refuses production, a remote database, and an `unknown`
  database; on the SQLite scaffold under `NODE_ENV=test` it judges
  `TEST_DATABASE_URL`, not `DATABASE_URL`; it never starts on a port other than
  the one it chose, and stops only its child.
- The doctor reports `inconclusive` for zero passing features, an incomplete
  map, an expired cursor or a replaced session, and `unavailable` with no
  collector; a 500 recorded during the run fails it even when the landmark
  returned 200.
- The browser seeder writes nothing without `GUREN_BROWSER_SEED=1` and nothing
  in production with it.
- `browser:record --close` turns a recorder's `pass` into `fail` when the step's
  window holds an event and into `inconclusive` when the window is not
  conclusive; it refuses an unopened step and a screenshot outside the run.
- Every field of a step record carries its source, and `run.json` has no writer
  but `browser:record`.

### 11. Non-goals

No model calls from Guren, no agentic test runner, no visual regression, no
mobile engine, no production use, no new dependency in any `@guren/*` runtime
package, and no change to what `verified` means.

## Alternatives Considered

**Adopt tester-army/e2e as the engine.** Its replayed agent steps suit flows that
change often, and the skill may name it as a live-drive option. As the default
it would require a model key for agent steps in CI, and the 0.20 package declares
Node engines only. The map, serve and doctor here are engine-neutral, so
adopting it later costs a spec template, not a redesign.

**Vendor `create-verification-skill` unchanged.** Every app would get a
generated skill written from an agent's reading of the source, which drifts from
the graph and cannot be regenerated without losing edits. Reading the answers
from the framework and keeping app facts in a marker-fenced map avoids both.

**Let the doctor start the app.** A doctor that launches and stops its own
instance describes a process the next step no longer has. Splitting launch into
`browser:serve` gives the doctor, the live drive and Playwright one instance and
one set of launch checks.

**Judge the database from `DATABASE_URL`.** Simple, and wrong whenever
`NODE_ENV` selects another variable or a resolver ignores it. The manifest
section is the cost of a check that reads what the app will actually use.

**Render pages inside `TestApp`.** Server-rendering the page component in
process would catch a render throw with no browser. It cannot click, fill or
hydrate, so it misses the form and route defects above.

**Do nothing.** Agents with browser tools already look at pages ad hoc. Without
a map, a launcher and a doctor, each session rediscovers the launch, port and
database rules, and a result has no stable place to live.

## Migration Path

Additive. Existing apps receive the skill on `guren agent:sync`; the commands
and blueprint are opt-in. A server older than the `database` section makes
`browser:serve` refuse with a message naming the upgrade; nothing existing
changes behaviour.

## Open Questions

1. Is `docs/browser/` the right home, or should the map live beside the harness
   (`.agents/`) where the tester-army skill puts it? `docs/` gets the docs graph
   and `check --docs`; it also puts generated tables in user-facing docs.
2. The first page-path segment fits `make:feature` apps. Is it wrong for apps
   organised by flow (checkout, onboarding), and should page module ownership
   enter the graph before M1?
3. `@playwright/test` under Bun 1.4.2: the blog runs it through the package's
   Node shim. Is Node on PATH an acceptable requirement for the blueprint, as it
   is for `bun run lint`?
4. Should `browser:map --check` join `guren check` as an advisory result?
5. The seeded browser account: one per app, or one per acceptance `actor`?
6. Should SSR fallback become observable (a counter in the collector, or a
   response header in development) so the doctor can fail on it?
7. Should the doctor accept a signed-in session so `auth-required` landmarks can
   be checked, and where would that cookie come from without a password in the
   CLI's arguments?
8. Should plans see browser runs? Options, weakest first: nothing (this RFC);
   `plan:status` lists the latest run per acceptance id as information, never a
   state; `plan:close` cites it in the entity document's History. Any of them
   needs a rule for a run made against an older commit or graph snapshot, which
   `run.json` records but nothing yet compares.
9. A route a framework package registers (`registerAttachmentRoutes()` in
   `examples/blog`) has its controller outside the app, so the graph's `handles`
   is partial and `browser:map` exits 1 on every run (found in M1). Under §4 the
   doctor could then never pass for such an app. Should the graph mark these
   routes as registered by a package, so their controllers are an established
   fact rather than a gap, or should §4 accept a gap confined to routes no
   feature can own? The map must not grow its own exception; this needs
   deciding before M2.

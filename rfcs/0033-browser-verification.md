# RFC: Browser Verification for the Agent Harness

**Author:** Guren contributors
**Date:** 2026-10-14
**Status:** Accepted (2026-10-15; the deciding maintainer asked for implementation to start
and shortened the standard discussion period.) The amendment in §12 (accessibility checks and
visual change between runs) was accepted on 2026-10-31. The amendment in §13 (behaviour specs
through an agent runner) was proposed and accepted on 2026-11-14; the deciding maintainer
shortened the discussion period after the measurements in §13.1.

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
  picks its own. The child gets `GUREN_VITE_PORT=<port + 1>` unless the caller
  set it, so Vite starts clear of a `guren dev` holding 5173, and walks past a
  busy port from there.
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

**Amended in implementation:**
- The run is opened before the doctor, so `--evidence <run>` has somewhere to
  write its report.
- A refusal from `browser:serve` is reported to the person with its remedy;
  the skill forbids working around it (another start, another database, an
  edited `.env`).
- Until the Playwright blueprint (M3) is installed, a finding is reported as
  observed, with the run and step that show it, not as a bug, and no spec is
  written under `tests/browser/`, where `bun test` would collect it.
- Database rows are checked read-only under the `DATABASE_URL` and `NODE_ENV`
  the instance was started with, so a check never reaches a database
  `browser:serve` did not judge.
- A charter is recorded under its kind (`charter-validation`), and a step id is
  recorded once.
- Files touched were the skill, `core/entry-body.md` (a command block, as for
  plans) and the three hand-kept lists of shipped skill names that
  `tests/harness-skill-name-lists.test.ts` pins (the harness guide in both
  locales and the catalog's `guren-harness` skill); `rules-catalog.md` and the
  workflow fragments name no skill this one needs to join.

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

**Amended in implementation:**
- Spec files end in `.browser.ts`: `bun test` collects `*.spec.ts`, so
  `tests/browser/smoke.spec.ts` would run under Bun's runner too, and the app's
  `bun test` and `guren gate` would fail on it. `plan:verify` and `check --docs`
  read only `*.test.*` files, and the specs carry no bracketed acceptance id
  either, so no browser spec is ever read as the test of a plan behaviour (§8).
- The config is `playwright.browser.config.ts` and the script is
  `playwright test -c playwright.browser.config.ts`, so an app with its own
  Playwright suite (the blog's `e2e/`) keeps it, and these specs never run under a
  config that starts no `browser:serve`. A `test:browser` script that runs
  anything else refuses the command before any write; `--force` replaces it.
- The specs from plan views belong to `browser:map`, not the blueprint: once
  `playwright.browser.config.ts` exists, every `browser:map` run rewrites
  `tests/browser/generated/` and `--check` reports a stale spec, so a plan
  approved later reaches the specs the way it reaches the map. The blueprint
  writes its files once and runs `browser:map` at the end. A generated spec
  nothing produces is removed (no author text lives in one). A file at a path
  the run produces (or one differing from it only by case) that lacks the
  generated header refuses the run; any other file there is left alone.
- The specs are a smoke spec (one test per landmark, comparing the Inertia
  component as the doctor does) and one spec per approved plan with views: each
  form field by its label and each action as a button or a link by its name,
  visible, on the route the map resolves for the view (the first GET route in
  registration order rendering its page with no path parameter, the landmark's
  rule). A view whose page no feature holds yet is kept in the map rather than
  dropped. What the spec cannot open (a path parameter, no route yet, a
  signed-in route without password sign-in) is a `test.fixme` naming why, never
  a pass. Two approved plans of one slug refuse, since their specs would be one
  file.
- Password sign-in is detected on positive evidence only: the root `users` table
  declares `email` and `passwordHash`, and the map holds a `POST /login` route.
  An OAuth-only app gets no setup project, and its signed-in landmarks are
  `fixme`. The setup project targets the labels `make:auth` writes (`Email`,
  `Password`, `Sign in`), which a test pins, and saves a session only after a
  fresh load shows a page outside `auth/`.
- The seeder writes `browser@example.test` with an upsert that also updates the
  password hash (and `emailVerifiedAt` where the table has it), so a changed
  `BROWSER_TEST_PASSWORD` takes effect at the next `browser:serve`. It runs
  through boot-time seeding, which the blueprint warns about when
  `config/database.ts` never sets `seedOnBoot`. With the password unset it warns
  and writes nothing, rather than seeding a default. The key is declared in
  `config/env.ts` as an optional secret, so `check` does not report it.
- Playwright loads no `.env`, so the config loads `.env.local`, `.env.<NODE_ENV>`
  and `.env` with `process.loadEnvFile()`, most specific first, a value already
  set winning: the files Bun loads for the app.
- The JSON reporter writes to `.guren/browser/$GUREN_BROWSER_RUN/spec-report.json`
  only for a run `browser:record --begin` opened (its name in that shape and its
  `run.json` present); the config throws otherwise. `browser:record` does not
  read the report: a spec run starts its own instance, so its server errors are
  outside the run's error window.
- The ignore entries go to the app's `.gitignore`, since an existing app has
  no `_gitignore` template.
- The plan command allowlist classes `add browser-tests` as `dependencies`, like
  `add plugin`: installing a browser toolchain is the app owner's decision, not a
  plan step's.

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

**Amended in implementation:**
- ~~Each field says who established it~~: the step groups its fields by source
  instead, `recorder` (the agent's or a spec's account, verbatim) and `cli`
  (the screenshots with their sha256, and the error window's status and event
  count). `result` sits beside them, with `lowered` naming why the CLI lowered
  it. A field one group holds is never in the other.
- An open step's cursor is kept in `run.json` under `open`, so a run survives
  between commands; `--close` removes it.
- `run.json` also records the graph snapshot id (null when the graph cannot be
  read) and the commit with whether the tree was dirty, for Open Question 8.
- The run name must be one `--begin` could write (a stamp and a slug), so no
  path leaves `.guren/browser/`. A step id is an acceptance id or a charter
  slug and never a key an object already holds, so a step that was never opened
  cannot be closed. A screenshot is resolved through links and must land inside
  the run's `screenshots/`.
- `--evidence` checks the run exists before the doctor runs and files the
  report only into a run against the same origin.
- Steps of one run are recorded one at a time: the commands read and rewrite
  `run.json` without a lock. Runtime-error events are appended once per session
  and sequence, so a retried close records none twice.

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
| M5 | Accessibility spec and visual change between runs (§12) | The measurement app has no axe violation under the §12.2 tags before the spec ships; `--close` reports `unchanged`, `changed` and `new` in fixtures and never moves a result |
| M6 | Behaviour specs through an agent runner (§13) | §13.9 holds on the measurement app before the blueprint option ships |

**Amended in implementation:** the skill moved from M1 to M2. Its launch, doctor
and evidence steps name `browser:serve`, `browser:doctor` and `browser:record`;
shipped before them, it would either point at commands that do not exist or
launch the app without §3's checks.

**M4 measurement.** `bun run smoke:browser-tests` builds a golden-path-shaped
app on SQLite (auth and a posts resource, migrated; no second resource, no
seed), approves one plan describing the posts pages through `plan:approve`,
runs `guren add browser-tests`, and runs `test:browser` from a cold start forty
times, each start one run of every spec with no retries, as a gate would run
it. A start is timed whole and by its tests' own time; the scaffold, the
approval, the blueprint and the Chromium download are timed as their own
phases, which the rule does not count. A test failing in every run is a defect,
one failing in some runs a flake, one that never ran (its setup project failed)
is not run, and a start with no report is a start-up failure. Only the last
three bear on a gate's reliability, so a night is clean when all three are zero.
The `Browser Specs Measurement` workflow runs it nightly, outside every gate,
keeps each night's metrics and Playwright reports for 90 days, and reads the
previous nights back to report the current streak of clean nights.

The rule was adopted provisionally on 2026-10-17; whether an acceptance may
require a browser run is decided once the nightly data meets it. The rule holds
the browser run to the reliability of the CI this repository already runs: it may become required
once it fails without a fault in the code no more often than CI does, and once a
start costs under two minutes on the CI runner. The baseline is CI's own record.
Of the 997 `CI` runs on `main` from 2026-07-24 to 2026-10-16, 27 failed. Read one
by one (the failing jobs' annotations and the commit after each), they split as
follows:

| Cause | Runs | Counted in the baseline |
| --- | --- | --- |
| Code broken by the commit, fixed by a later one | 5 | No |
| A newly published advisory failing the dependency audit | 4 | No |
| Infrastructure or runtime: a service container that would not start, a 15-minute hang, Bun 1.4 crashing with exit 139 | 8 | Yes |
| Tests depending on timing or memory thresholds | 10 | Yes |

That is 18 runs in 997, about 1.8% of CI runs failing with no fault in the code.
It is an estimate, not a measurement: the split was read by hand, runs are almost
never re-run (one in the window), so no failure is confirmed as a flake by a
pass on the same commit, and pull request runs are left out because their
failures are mostly real. The `e2e` job, the one Playwright job, failed once,
when its database container did not start.

By the rule of three, 167 consecutive clean cold starts bound the browser run's
rate under 1.8% at 95% confidence: about five nights at forty starts. A tighter
comparison with the `e2e` job alone (no test-caused failure in 997 runs, a rate
under 0.3%) would need about a thousand starts, which is why the baseline is CI
as a whole. The aggregate step reports whether the rule is met, and the baseline
is re-read when CI's own record changes enough to move it. The decision covers
the SQLite scaffold; the drivers share the browser, hydration and start-up paths
that flake, but not the database. Until the decision is made the generated
specs stay advisory.

The first local runs on macOS found two defects the scaffold shipped rather than
flakes: the form fields `make:feature` wrote had no label, so the posts New
view's spec failed in every run, and the profile page `make:auth` wrote did not
associate its labels with their inputs (found in M3's live check). Both are
fixed (gurenjs/guren#1196, gurenjs/guren#1193), so the measured spec set now
includes the posts form. The first run on the CI runner made twenty cold starts,
all clean, at 6.1 to 6.5 s each (2.4 s of it the tests), and the whole job took
under three minutes, so a night makes forty.

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

No model calls from Guren, ~~no agentic test runner~~ no agentic test runner in
the default install, in any `@guren/*` package or in any gate (**amended in
§13:** an app may opt into one for behaviour specs), ~~no visual regression~~ no
visual regression baseline or gate (**amended in §12:** no committed reference
image, no pixel threshold, and no result a screenshot can pass), no
mobile engine, no production use, no new dependency in any `@guren/*` runtime
package, and no change to what `verified` means.

### 12. Amendment after acceptance (2026-10-31): accessibility and visual change

**Accepted 2026-10-31.** Guren is gaining design-system features (UI
components, form fields derived from route contracts, a token stylesheet an app
can upgrade). A design system holds on real pages only if something looks at
them, and the browser specs are the one place that does. Two defects the M3
specs found, form fields `make:feature` wrote with no label (#1196) and labels
on `make:auth`'s profile page tied to no input (#1193), were found by locating
fields by label, which is an accessibility check the specs ran by accident.
This amendment makes it deliberate, and lets a run say whether a page looks as
it did in an earlier run.

#### 12.1 Why this is an amendment

- §11 names visual regression as a non-goal. Comparing screenshots between
  runs is close enough to it that the line has to be redrawn in the RFC, not in
  a pull request.
- §6 lists what the blueprint installs. A second devDependency, under a licence
  the app has not taken on before (MPL-2.0), is the kind of change the RFC
  process lists as needing one ("new dependencies").
- §7's step record gains a field, and §10's acceptance list pins what the
  record holds.
- §9's M4 rule was met on the current spec set (14 clean nights, 560 cold
  starts, as read on 2026-10-31). A new set of tests in `test:browser` changes
  what that measurement covers, so the RFC has to say how the new tests are
  counted.

#### 12.2 Accessibility checks in the generated specs

**Engine.** `@axe-core/playwright`, Deque's wrapper around `axe-core`. As
checked on 2026-10-31: both are maintained by Deque in public repositories
(`dequelabs/axe-core`, `dequelabs/axe-core-npm`), neither archived, both pushed
to that week. `axe-core` 4.14.0 was released on 2026-10-05 and the wrapper's
4.14.0 on 2026-10-15, after minors in June and August. The wrapper's one
dependency is `axe-core ~4.14.0`, and its peer is `playwright-core >= 1.0.0`,
which `@playwright/test` brings. Both are MPL-2.0, a file-level copyleft: the app
installs them as devDependencies and ships none of their files, and no
`@guren/*` package depends on them, so §11's rule on runtime packages holds.

**Range.** A new `axe-core` minor adds and tightens rules, so an unchanged page
can fail after an install. The blueprint installs the range `@guren/cli`
declares for its own devDependency, as it does for `@playwright/test`, and that
range is a tilde (`~4.14.0`): a new rule set reaches an app when `@guren/cli`
moves the range, in a release whose changeset says so.

**Installation.** `guren add browser-tests` installs `@axe-core/playwright`
beside `@playwright/test` and writes `tests/browser/a11y.ts` once (author-owned,
like `support.ts`):

```ts
/** Read by tests/browser/generated/a11y.browser.ts. Say why beside every entry. */
export const a11y = {
  /** axe rule ids not checked, e.g. 'color-contrast' while the palette is being replaced. */
  disableRules: [] as string[],
  /** CSS selectors axe does not descend into, e.g. a third-party widget. */
  exclude: [] as string[],
}
```

An app that ran the blueprint before runs it again: it writes only files that
are missing and installs only packages the manifest does not declare, so the
rerun adds these two and changes nothing else.

**The spec.** `browser:map` writes `tests/browser/generated/a11y.browser.ts`
only when the app's manifest declares `@axe-core/playwright` and
`tests/browser/a11y.ts` exists (positive evidence, as for password sign-in).
Otherwise it writes none, removes one it wrote before, and ~~the map index says~~
**the command prints that** (amended in implementation, below)
the accessibility checks are off and names the rerun. The spec holds one test
per mapped landmark and one per plan view the view specs open, titled
`a11y <feature>: GET <path>` and `a11y view <id>`, with the same visit, the same
signed-in grouping and the same `test.fixme` rules: a visit the smoke or view
spec cannot make is a `fixme` here too. The checks sit in their own tests, not
inside the smoke tests, so a page that renders the wrong component and a page
that fails a rule are two facts, and the measurement can count them apart.

Each test, after the visit and the component assertion that shows the page is
the one meant:

1. runs `new AxeBuilder({ page })` with the tags `wcag2a`, `wcag2aa`,
   `wcag21a`, `wcag21aa` and `wcag22aa`, the rules of `a11y.disableRules`
   disabled and the selectors of `a11y.exclude` excluded;
2. attaches ~~the whole result~~ the violations and the `incomplete` results
   (amended in implementation: axe's passes and inapplicable rules are left out)
   as JSON to the test, so the report a run files as
   `spec-report.json` (§6) carries it, and names every disabled rule and
   excluded selector there, so an exemption stays visible in every report;
3. fails when `violations` is not empty, with a message listing each rule id,
   its impact, its help URL and the first targets of its nodes. `incomplete`
   (a rule axe could not decide, such as contrast over an image) is attached
   and never fails the test.

`best-practice` rules (landmark regions, heading order) are left out: they are
advice rather than conformance criteria, and on an existing app they are most
of what axe reports. An author who wants them adds a spec beside the generated
ones.

**Failing, and advisory.** A violation fails its test. A check that cannot fail
tells nobody anything, and a Playwright annotation on a passing test is read by
no one. The specs are already advisory where it matters (§8): no gate reads
them, so a failing accessibility test reddens `test:browser` and nothing else.
The noise on an existing app is bounded by opting in twice (the blueprint, then
the package), by the pinned rule set, and by `a11y.ts` for what a team decides
to leave for later. A baseline of accepted violations, keyed by rule and
selector, is not part of this amendment: selectors change with every markup
edit, so such a file goes stale faster than it is read (Open Question 10).

**The scaffold first.** A new app must not start with a red `test:browser`.
Before the spec ships, the measurement app (`smoke:browser-tests`: `make:auth`
and a posts resource on SQLite) is run with the spec, and every violation found
there is fixed in the template that wrote the page, as #1196 and #1193 fixed the
labels. M5 is done only once that run reports none.

**Live drives.** The CLI runs no axe, and the step record (§7) gains no
accessibility field. An agent driving a page live reports an accessibility
problem through the rule §5 already sets for findings: once an `a11y` test in
`tests/browser/` fails on it. The skill tells the agent to run `test:browser`
after changing a page and to report a failing `a11y` test with its rule ids.

**Amended in implementation:**
- Why the checks are off (the package not in `package.json`, or no
  `tests/browser/a11y.ts`) is printed by `browser:map` and `add browser-tests`,
  not written into the index: the index is the same in every app, with or
  without the blueprint, and the reason is about the install.
- Before running axe, a test waits for `#app` to hold an element and for the
  network to go idle, so a client-rendered page is read after it renders.
- A view whose route a landmark already checks is not checked twice, and a
  `fixme` two plans share is written once: every plan's views share this file,
  and Playwright refuses to load a file with two tests of one title.
- A start's cost under §9's ceiling leaves out the accessibility tests' time,
  which the measurement reports with their set.
- Both packages are installed in one `bun add -d`, and only the ones the
  manifest lacks, so a rerun on an app with Playwright adds axe alone.
- The first measurement run with the spec found two violations, both on pages
  `make:auth` writes: `link-in-text-block` on `/login` (the sign-up link inside
  a sentence was told apart by colour alone) and `color-contrast` on `/profile`
  (helper text in `text-g-muted`, about 2.5:1 on the panel). The links are
  underlined and the helper text uses `text-g-text-2`; the next run reported
  none of the six tests failing. `--g-muted` itself is too faint for any text,
  which is the token stylesheet's to settle, not this spec's.

**Measurement.** The nightly measurement already classifies every test in
`test:browser`, so the `a11y` tests are measured from the night they ship. They
are reported as their own set (tests whose title starts with `a11y `), and their
defects, flakes and unrun tests do not reset the streak of the set M4 was
judged on. Whatever M4 decides covers the smoke and view specs; the `a11y` set
joins such a requirement only after its own 167 clean cold starts under §9's
rule.

#### 12.3 Visual change between runs

**What is compared.** `browser:record --close` already stores each screenshot of
a step with its sha256 (§7). For each screenshot it now also finds the latest
earlier run (run names sort by their UTC stamp) of the same feature that
recorded a step with the same id holding a screenshot at the same path under
`screenshots/`, and records the pairing in the step's `cli` group:

```ts
screenshots: Array<{
  path: string
  sha256: string
  /** Absent when no earlier run of this feature recorded this step with a screenshot at this path. */
  previous?: { run: string; sha256: string; commit: { rev: string; dirty: boolean } | null }
}>
```

The close prints each screenshot as `unchanged since <run>` (equal digests),
`changed since <run>` (both paths, so a person can open the two), or `new`. A
changed digest where both runs name the same commit with a clean tree is printed
as changed at the same commit: the page does not render the same twice (a
timestamp, seeded data, an animation caught mid-way), which a reader needs to
know before treating any other change as the code's doing. An earlier
`run.json` that does not read is skipped and counted in the output, never
compared.

**Never a result.** The comparison is reported and stored, and that is all. It
does not enter `lowerResult()`, which keeps lowering on the error window alone,
and nothing it finds raises a result. `unchanged` is not a pass and `changed` is
not a failure: both say only whether to look.

**Bytes, not pixels.** Equal digests prove the images are equal. Different
digests prove less: another Chromium build, font hinting or a timestamp on the
page changes the bytes of an image a person would call the same. Erring that way
is the safe side for a report whose only use is "look here". Comparing pixels
needs a PNG decoder in `@guren/cli` and a threshold someone has to tune
(Open Question 11).

**The key.** A screenshot is paired by feature, step id and its path under
`screenshots/`, so a pairing holds only while the agent names a screenshot the
same way in every run. The skill tells it to name each screenshot after the
state it shows (`comment-posted.png`), never by the order it was taken in.
The origin is not part of the key, since `browser:serve` may start on another
port each session.

**Scope.** `.guren/browser/` is git-ignored, so a run is compared with earlier
runs in the same checkout. `run.json` keeps `schemaVersion: 1`: `previous` is
optional, an older record reads unchanged, and an older CLI reading a newer
record drops the field.

**Amended in implementation:**
- Only runs whose name carries the feature's slug are read, and the search
  stops once every screenshot is paired, so an unreadable `run.json` is counted
  only where it could have held a later pairing. A run directory with no
  `run.json` (a `--begin` still writing it) is skipped without being counted.
- stdout stays the step record as one JSON line, now carrying `previous`; the
  per-screenshot lines and the count are printed on stderr, as `browser:serve`
  keeps its own report off stdout.
- The commit each side is judged by is the tree when its step closed, recorded
  as `cli.commit` on the step, not the run's `--begin` commit, which an edit
  made during a run leaves stale. An earlier step recorded without one reads as
  no commit, so it is never called the same commit.

**What stays a non-goal.** Playwright's `toHaveScreenshot()` in the generated
specs: it needs reference images committed per platform (macOS and Linux render
fonts differently), a ritual to update them and a pixel threshold, and it turns
a screenshot into a test result. That is the visual regression §11 keeps out.

#### 12.4 What changes in §§5 to 10

| Section | Change |
| --- | --- |
| §5 skill | Run `test:browser` after changing a page and report a failing `a11y` test with its rule ids; name screenshots by the state they show; report `changed` screenshots as a prompt to look, never as a regression or a pass |
| §6 blueprint | Also installs `@axe-core/playwright` and writes `tests/browser/a11y.ts`; `browser:map` owns `generated/a11y.browser.ts` under the conditions in §12.2 |
| §7 evidence | `cli.screenshots[].previous`; the close output names `unchanged`, `changed` or `new` per screenshot |
| §8 gates | Unchanged: no gate reads an accessibility result or a screenshot comparison |
| §9 delivery | M5 |
| §10 acceptance | The additions below |

#### 12.5 Acceptance for this amendment

- `browser:map` writes `a11y.browser.ts` only when the manifest declares
  `@axe-core/playwright` and `tests/browser/a11y.ts` exists, removes the one it
  wrote when either goes, and ~~the index names~~ `browser:map` prints why the
  checks are off.
- An `a11y` test fails on a page with an input that has no label, passes on the
  same page with the label, and names the disabled rules and excluded selectors
  in its attachment.
- A landmark the smoke spec marks `fixme` is a `fixme` in the `a11y` spec, with
  the same reason.
- `smoke:browser-tests` reports no violation on the measurement app before M5
  ships, and reports the `a11y` set apart from the set M4 was judged on.
- `--close` records `previous` for a screenshot an earlier run of the feature
  and step holds at the same path, reports `unchanged`, `changed`, `changed at
  the same commit` and `new` in fixtures, and leaves `result` and `lowered`
  exactly as `lowerResult()` set them in every case.

#### 12.6 Alternatives considered

**Inject `axe-core` without the wrapper.** `page.addScriptTag()` with the
`axe-core` file and an `axe.run()` call works and drops one package, but the
wrapper also runs axe in every frame and merges the results, which a page with
an embedded widget needs. The wrapper is 48 KB on top of `axe-core`.

**Lighthouse or pa11y.** Both drive their own browser rather than the page the
spec already opened and signed in to, and Lighthouse reports a score, which
invites a threshold. axe reports rule violations with selectors, which is what
a fix needs.

**Warnings only.** Attach the violations and let the test pass. Nobody reads an
annotation on a green run, and the specs are advisory to every gate already, so
a failing test is the advisory form.

**Check accessibility in `browser:doctor`.** The doctor opens no browser (§4),
and axe needs a rendered DOM.

### 13. Amendment after acceptance (2026-11-14): behaviour specs through an agent runner

**Accepted 2026-11-14,** on the day it was proposed: the deciding maintainer
shortened the discussion period once §13.1's measurements were in. §13.8 lists
what changes in §§5 to 11. Nothing of it is implemented yet. M6 (§9) builds it,
and the blueprint option ships only once §13.9 holds, including the three items
there that no measurement has covered so far.

The generated specs open a page and check that a view's labels and actions are
visible (§6). None performs a behaviour: fills the form, submits it and looks at
where the browser lands. A plan's behaviours are tested through `TestApp`, over
HTTP, which sees no hydration, no client-side form state and no `confirm()`
dialog. The live drive (§5) does perform them, once per session, and leaves a
record but no test that a later change runs again.

A plan states a behaviour as a route, an input and an outcome. A view's
`form.submitsTo` and `actions[].route` name the page that sends the request, and
its field labels name most inputs. Nothing states how a `select`, a file input
or a date control takes its value, or that a delete button asks first. An agent
step fills that gap once, and a recorded step replays with no model. This
amendment adds such specs as an option an app chooses, on
[e2e](https://github.com/e2e-inc/e2e), the runner the Alternatives section
names as tester-army/e2e.

#### 13.1 What was measured

On 2026-11-12, against `examples/blog` started by `browser:serve` on a local
database made for the run, with `e2e` 0.23.0 on Node 22.23.5 and agent steps
run by Claude Code under a subscription login (`claudeCode({ model: 'sonnet' })`
from `@e2e-dev/acp`, no API key). The test created, retitled and deleted a post
in three agent steps, each followed by a locator assertion.

| Measured | Result |
| --- | --- |
| One agent step, live | 8 to 30 s; 40,000 to 80,000 tokens, 85 to 95% of them cache reads |
| Three steps, live | 34 to 57 s |
| Three steps, replayed | 2.3 s, no model call |
| A recording | one JSON file per step under `.e2e/cache/`, about 3 KB |
| CI mode, no login, every step replayed | passes in 2.7 s |
| CI mode, no login, one step with no recording | fails: `MODEL_PROVIDER_FAILED`, authentication required |
| No agent in the config | `MODEL_UNAVAILABLE` before any replay, so the agent stays configured in CI |
| `e2e` 0.23.0 on Bun 1.4.4 | does not start: Bun has no `module.registerHooks` |
| `e2e` 0.23.1 nightly on Bun 1.4.4 | the same tests pass, live and replayed |

"No login" was an empty Claude configuration directory.

On 2026-11-14 the test was repeated on the released `e2e` 0.23.1, which carries
the Bun loader (e2e-inc/e2e#1616), under Bun 1.4.4. This time the runner started
the app itself, through `app.command` running `browser:serve` on port 4319.

| Measured on 0.23.1 under Bun | Result |
| --- | --- |
| Three steps, live | 33.6 s, 146,000 tokens, each step recorded |
| Three steps, replayed | 3.2 s including the app's start, no model call |
| `--strict-cache`, no login, recordings current | passes in 3.4 s |
| `--strict-cache`, no login, the submit button renamed | fails after 14 s with `REPLAY_STALE` and no model call; the recordings are left as they were |
| The same without `--strict-cache` | fails with `MODEL_PROVIDER_FAILED`, authentication required |
| A run that passed, failed, or was interrupted (`SIGINT` to its group, `SIGTERM` to the runner) | no app process and no listener left |
| `shutdownTimeout: 1`, six runs | none left |
| `SIGKILL` to `browser:serve`'s group during a run | the app keeps both ports; the next run refuses with `APP_ALREADY_RUNNING` |

The runner stops a command by sending `SIGTERM` to its process group and
`SIGKILL` to that group once `shutdownTimeout` passes. `browser:serve` stops the
app on `SIGTERM`, which is why nothing was left. The app runs in a group of its
own (§3), so the `SIGKILL` never reaches it: a `browser:serve` killed before it
handles `SIGTERM` leaves the app behind, as the last row shows.

Four things went wrong, and §13.5 is shaped by them:

- **A recorded URL.** The edit page is reached by URL only, so the agent
  navigated to `/posts/3/edit` and the recording kept that path. The next run's
  post had another id, the replay opened a 404, and the agent took the step over
  on every run. With the test opening the path and the agent given only the goal
  on that page, the step replayed.
- **A shared key.** A recording is keyed by the test's title, the instruction
  and its parameters. After the test was rewritten under the same title, the old
  recording was repaired run after run and grew to eight actions, seven of them
  navigations to posts that no longer existed.
- **A dialog.** `confirm()` stops a step (`AUTOMATION_UNSUPPORTED`) unless the
  test registers `browser.onDialog('accept')` first.
- **A policy failure.** One of nine live runs failed with `POLICY_DENIED`: the
  agent used a tool of its own named `navigate`. The cause was not found.

The first run also downloaded a Chromium build without asking (99 MiB, 216 MB on
disk), since `@e2e-dev/web` pins its own `playwright-core`.

Later on 2026-11-14 the acceptance of §13.9 was run on the measurement app
(`smoke:browser-tests` at `@guren/cli` 2.36.4: `add auth` and a posts resource
on SQLite), on Bun 1.4.4 and `e2e` 0.23.1. No generator exists yet, so the
config and four tests were written by hand to §13.4 and §13.5: create a post, a
title of spaces refused, retitle a post, delete a post. Each test holds one
agent step.

| Measured on the measurement app | Result |
| --- | --- |
| Four steps, live | 55 s, 164,000 tokens, each step recorded |
| Four steps, replayed | 7 s including the app's start, no model call |
| One live step, over 65 | 8.8 to 15.9 s, median 10.4 s; about 41,000 tokens, 88% of them cache reads |
| `--strict-cache`, no login, recordings current | passes in 8 s; the summary reads `4 replayed` |
| The same, the submit button renamed | the two tests that use it fail with `REPLAY_STALE` after 14 s each and no model call, exit code 2; the other two replay |
| The same, one test under a new title, so with no recording | that test fails with `MODEL_PROVIDER_FAILED`, authentication required, exit code 3; the other three replay |
| Logged in, the test under the new title | one recording is added; the four earlier files are byte for byte what they were |
| `NODE_ENV=production` | `APP_UNREACHABLE`: `browser:serve` exits before any app starts, and the runner prints its refusal |
| Another server already answering on 4319 | `APP_ALREADY_RUNNING`; the run attaches to nothing |
| A run that passed or failed; `SIGINT` or `SIGTERM` to the runner | no app process and no listener left |
| `POLICY_DENIED` | none in 65 live steps of the four tests |

The policy failure above was not reproduced. Ten more live steps were given a
goal the start page has no control for (the profile page, from the posts
list), the shape of the step that failed on 2026-11-12, and none was denied. The
tests of that day held three agent steps in one agent session; these hold one.
The cause is still not named.

Three more things were found. They change §13.4, §13.5 and §13.7:

- **Bun hands the app's env files to the agent.** Bun loads `.env` into every
  Bun process started in the app's directory. Under `bunx --bun e2e run` the
  runner held all sixteen names of the app's `.env`. The runner starts the
  agent's adapter as a second Bun process in the same directory, which loads
  the files again, so the Claude Code process was started with `APP_KEY`,
  `SMTP_PASS`, `DATABASE_URL` and `BROWSER_TEST_PASSWORD` in its environment,
  the last of them after the config had deleted it from `process.env`.
  `--no-env-file` on the runner does not reach the adapter, and `env = false`
  in `bunfig.toml` stops the app from reading its own files. With the runner
  under Node 22.23.5, neither process held any of them. What worked under Bun:
  the config deletes every name the env files set from `process.env` and gives
  the executor each name as an empty string. Bun's loader leaves a variable
  that is already set, so both processes were started with empty values only,
  and twenty live steps passed that way. This reads the environment a process
  is started with; what a process loads afterwards was not observed.
- **An empty value on a required control.** With the title empty, the browser's
  own validation stops the submit: no request is sent, the server renders no
  error, and the control never gets `aria-invalid`. The test failed on that
  pin, where the `TestApp` test of the same behaviour passes.
- **A one-segment pattern matches a sibling route.** A redirect to `/posts/:id`
  read as "one segment after `/posts/`" is satisfied by a browser still on
  `/posts/create`, the start page, so a submit that did nothing passes the URL
  assertion.

#### 13.2 Why this is an amendment

- §11 names an agentic test runner as a non-goal.
- §6 lists what the blueprint installs. Three more devDependencies, a second
  `playwright-core` and a second browser download are new dependencies in the
  RFC process's sense.
- The Alternatives section set the runner aside for two reasons. A model key
  for agent steps in CI: a committed recording replays with none, and a
  subscription login runs the live steps on a developer's machine. Node engines
  only: the manifest still declares Node alone, and 0.23.1 runs on Bun 1.4.3 or
  later for web tests.
- §9's measurement covers the Playwright specs. A second suite needs its own
  rule before anything may depend on it.

#### 13.3 The runner and its packages

As read on 2026-11-12 and 2026-11-14: `e2e-inc/e2e` is public, Apache-2.0, not
archived, created on 2026-07-22, pushed to on the day it was read, with 13,755
stars and 73 open issues. It released 0.23.0 on 2026-11-05 and 0.23.1 on 2026-11-13. It is four
months old and has no 1.0, so its configuration and its recording format may
change in a patch: the cache guide says an upgrade can give every recording a
new key.

| Package | Version | Role |
| --- | --- | --- |
| `e2e` | 0.23.1 | the runner and CLI |
| `@e2e-dev/web` | 0.16.0 | the browser engine; depends on `playwright-core` 1.65.0, exactly |
| `@e2e-dev/acp` | 0.1.2 | runs agent steps on Claude Code or Codex over the Agent Client Protocol |
| `@agentclientprotocol/claude-agent-acp` or `@agentclientprotocol/codex-acp` | as installed | the adapter for the chosen agent |

**Range.** Exact versions, the ones `@guren/cli` declares as its own
devDependencies (it needs them to typecheck the config template). A new version
reaches an app when `@guren/cli` moves them, in a release whose changeset says
whether recordings have to be made again.

**Amended in implementation:** the adapter is installed at `^0.107.0`, the
version the measurements ran on. No template imports it, so `@guren/cli` does
not declare it and the blueprint holds the range. The release check that every
range a scaffold installs has cleared the three-day gate (RFC 0039 §2) reads
these four, so no release ships a pin an app's own gate would refuse.

**No runtime dependency.** No `@guren/*` package depends on any of these at
run time, and Guren's own code still calls no model. The runner asks the
developer's coding agent, under that agent's login.

**Two Playwright copies.** `@playwright/test` (the app's range) and
`playwright-core` 1.65.0 sit side by side, each with its own Chromium build.
The blueprint prints the download before the first run makes it.

**Telemetry.** The CLI sends usage counts by default. The script the blueprint
writes sets `E2E_TELEMETRY_DISABLED=1`; an app that wants to send them removes
it.

**Runtime.** `bunx --bun e2e run` needs no Node. The Playwright specs still
do (Open Question 3).

#### 13.4 Installation

`guren add browser-tests --behaviours --agent <claude-code|codex>`, on an app
that already has the blueprint or in the same run. `--behaviours` without
`--agent` refuses and names both: whose login runs the steps is the person's
choice, and there is no default. `--agent codex` refuses until §13.9's Codex
item is measured. It writes, once:

- `e2e.browser.config.ts`: the target on `http://127.0.0.1:4319`, started by
  `app.command` as `guren browser:serve --port 4319` with `reuseExisting: false`,
  so every launch passes §3's checks and none attaches to a server it did not
  start; `web({ locale })` pinned as the Playwright config pins it (RFC 0036
  §5); `tests: 'tests/browser/behaviours/**/*.e2e.ts'`; the executor for the
  chosen agent; the browser account as an `e2e` credential (§13.7). The runner
  passes a command only `PATH`, `HOME` and what the config names, and refuses a
  bare `*`, so the config sets `inheritEnv: ['NODE_ENV']`: §3 refuses
  production on the caller's `NODE_ENV`, which would otherwise never arrive.
  Any other variable the shell sets is not passed, so `browser:serve` judges
  and starts the app on its env files alone; an app that selects its database
  from the shell adds the name to `inheritEnv` in this file, which is the
  author's after it is written. It also parses the names the app's env files
  set, deletes each from `process.env`, and passes each to the executor as an
  empty string, since Bun would otherwise load them into the agent (§13.7).
  **Amended in implementation:** `NODE_ENV`, `PATH` and `HOME` are left as they
  are when an env file sets them: the app's command inherits the first, and
  the adapter does not start without the other two;
- `tests/browser/behaviours/auth.setup.e2e.ts`, on the same evidence of a
  password sign-in as §6, saving the session `browser`;
- `tests/browser/behaviours/given.ts` (author-owned, like `a11y.ts`):

```ts
/** Read by tests/browser/behaviours/generated/. One entry per behaviour that needs data or a path parameter. */
export const given: Record<string, (fixtures: GivenFixtures) => Promise<Record<string, string> | void>> = {
  // 'AC-comments-store-1': async () => ({ post: '1' }),   // the values of the start page's path parameters
}
```

`GivenFixtures` is the test's `app` and `browser` fixtures, typed in that file.

- `test:behaviours` in `scripts` (`E2E_TELEMETRY_DISABLED=1 bunx --bun e2e run
  --config e2e.browser.config.ts`, so the suite runs on Bun whether or not Node
  is installed), and `test:behaviours:ci`, the same with `--strict-cache`;
- ignore entries for `.e2e/` except `.e2e/cache/`.

`bun test` collects no `*.e2e.ts` file, and the Playwright config matches only
`*.browser.ts`, so neither runner reads the other's specs. The plan command
allowlist already classes `add browser-tests` as `dependencies`, so no plan step
can run this.

#### 13.5 The generated specs

`browser:map` writes `tests/browser/behaviours/generated/<slug>.e2e.ts`, one
file per approved plan, only when the manifest declares `e2e` and
`@e2e-dev/web` and `e2e.browser.config.ts` exists. Otherwise it writes none,
removes what it wrote before, and prints why, as for the accessibility spec.
The rules for a file it does not own (§6) apply unchanged.
**Amended in implementation:** `tests/browser/behaviours/given.ts` has to exist
too, since every generated spec imports it, as the accessibility spec waits for
its options file (§12.2). The Playwright config is not a condition: the two
suites are kept apart. An app that shows no sign of having asked (the config,
`given.ts`, `@e2e-dev/web`, or a generated spec left on disk) is told nothing.

**Which behaviours.** Those of kind `success` or `validation` whose route is
not a `GET` and which a view of the plan sends: the view whose `form.submitsTo`
or `actions[].route` names the route. Every other behaviour is written as a
skipped test naming why, never left out and never passed:

| Not written | Reason given |
| --- | --- |
| `unauthenticated`, `forbidden`, `not-found`, `state` | needs a second actor, a missing record or a state the plan words in prose; `TestApp` pins it |
| a `GET` route | the smoke and view specs open it |
| no view of the plan sends the route | nothing says which page to start on |
| the route, or the page's route, is not registered yet | as §6 |
| a signed-in route with no password sign-in | as §6 |
| no outcome a browser can check | every expectation is a status or a database row, an `errors` key has no labelled field, or the view `expect.inertia` names has no label and no action |
| an input that is not a string, a number or a boolean | nothing says how a control takes it |
| a `validation` behaviour whose input ~~leaves empty a key that the route's form contract (RFC 0036 §2.1) renders with `required`~~ the form's own control may stop or change (**amended in implementation**, below) | the browser stops the submit, so no request is sent and no error is rendered (§13.1); `TestApp` pins it |
| a `QUERY` route | no form or link sends it |

**Amended in implementation: which validation inputs are skipped.** An empty
value on a `required` control is one case of a wider one. A control built from
the route's contract also carries `min`, `max`, `step`, a length and an input
type, and any of them stops a submit as `required` does. The generator reads
the plan, not the app's contract, so it judges from the plan's validator and
towards skipping: a labelled field left empty, a required one left out, a
number outside a `min` or `max` rule or not an integer where the type is one, a
string outside its length rules, one an `email` control would refuse (by the
HTML standard's rule) or that is no URL under a `url` rule, a date that is no
calendar date. A rule the plan words in prose is taken to be the
server's. The rule can skip a behaviour a browser could have run (an edit form
keeps the value of a key the input leaves out); it is meant never to write one
whose submit cannot happen.

**One test per behaviour.** For `AC-posts-update-1`, sent by the form of a
view on `GET /posts/:id/edit`, as the generator writes it (**amended in
implementation:** the example first given here pinned only what held before the
step):

```ts
test('AC-posts-update-1 (6a2991): a signed-in user retitles a post', { session: 'browser' }, async ({ app, agent, screen, browser }) => {
  const start = await begin('AC-posts-update-1', 'its start page /posts/:id/edit takes a path parameter', { app, browser })
  await app.open(`/posts/${start.value('id')}/edit`)
  await expectDefaultLocale(browser)
  const off = await browser.onDialog('accept')
  await agent.act('set "Title" to {title}, then use "Save"', { params: { title: 'Retitled post' } })
  await off()
  await expect(browser).toHaveURL(landed(['/posts/', { known: 'id' }], start))
  await expect(screen.getByRole('button', 'Edit').or(screen.getByRole('link', 'Edit')).first()).toBeVisible()
})
```

- **The start page is opened by the test.** The path is the first `GET` route
  with no path parameter that renders the view's page, the rule the view specs
  use. Where every such route takes a parameter, it is the first of them, with
  its parameters filled from `given.ts`; the view specs stop there with a
  `fixme`. No instruction carries a URL, which is what keeps a record's id out
  of a recording (§13.1).
- **`begin()`** is in the generated file, not in a file written once. It calls
  the behaviour's entry in `given.ts` and returns the parameter values. A
  behaviour with `given` text or a path parameter and no entry is skipped from
  the body with that reason. An entry prepares its data however the app can: a
  seeder that runs at boot, or the app's own pages.
- **The instruction is built from the plan.** A behaviour's `input` is a list
  of `{ name, json }` entries, one per field. Every entry becomes a parameter
  holding its decoded value, as the `TestApp` skeleton builds its body from
  all of them. An entry whose name the view's form labels reads
  `set "<label>" to {name}`; one the form does not label reads
  `set the field for <name> to {name}`, so the agent still has the value, and
  `browser:map` lists it as a field the plan's view lacks. The step ends with
  the label of the view action whose route is the behaviour's, or with "submit
  the form" when no action names it.
- **A dialog is accepted** for the length of the step.
- **The outcome is pinned by locators, never by the agent.** `expect.redirect`
  becomes a URL assertion. A `:param` the test does not know matches one
  segment, except a literal that another registered route has in that place:
  `/posts/:id` is not satisfied by a browser still on `/posts/create` (§13.1).
  `expect.inertia` becomes the labels and action names of the view
  it names, located as the view spec locates them. The landed component is not
  read: `window.__INERTIA_PAGE__` and the initial-page element are written by
  a full load only, and after a client-side visit they still name the first
  page. Each `expect.errors` key with a labelled field becomes
  `aria-invalid="true"` on that control, which `@guren/inertia-client/forms`
  sets. `agent.assert` is never generated: it calls the model on every run, so
  a spec holding one cannot run in CI without a login.
- **A pin that held before the step is not written** (amended in
  implementation). A redirect the start page's URL already satisfies (the same
  literals, and a parameter wherever the start page has one, whatever its name
  or constraint), and any label or action the sending view shows, under
  whatever view the plan lands on, are true before the agent does anything, so
  a submit that did nothing would pass them. A behaviour left with nothing is
  skipped. An optional or wildcard segment in a redirect is not
  pinned either, and one in the start page skips the behaviour.
- **At least one pin, or no test.** The runner saves a recording only after a
  locator or URL assertion passes behind the step; an assertion on a plain
  value does not count. A behaviour with none of the pins above could neither
  fail nor record, so it is skipped (the table above).
- **Not pinned:** `expect.status` (an Inertia visit shows a page, not a
  status) and `expect.database` (no browser run reads the database, §7). Both
  stay with the `TestApp` test of the same behaviour.
- **The title** holds the behaviour's id without brackets, as §6 keeps a
  browser spec from reading as a plan's test, and a digest of what was
  generated (start route, instruction, pins). A regenerated test that differs
  gets a new title, so a new recording, and never repairs an old one (§13.1).
  The recording of the previous title stays on disk until `e2e cache clear`
  (Open Question 15).

A signed-in route runs under the session `browser`, the seeded account of §6;
~~any other route runs signed out~~. **Amended in implementation:** every other
route runs under that session too when the app has the sign-in setup, except a
route the graph reads as guest-only. The graph reads authentication from
middleware, and the scaffold's own actions refuse a guest in their body
(`this.auth.userOrFail()`), so on the measurement app `POST /posts` read as
public and would have been driven as a guest into a 401. Which account a
behaviour's `actor` means is still Open Question 5.

#### 13.6 Recordings

- **Committed.** `.e2e/cache/` is test data. A recording changes only when a
  step records for the first time or is repaired, so a diff there accompanies
  the page change that caused it and is reviewed with it.
- **Recording needs a login, replaying does not.** A developer, or the agent
  that changed the page, runs `test:behaviours`: a step with no recording, or
  one whose recording no longer matches, runs live under the Claude Code or
  Codex login and records.
- **CI runs `test:behaviours:ci`.** Under `--strict-cache` a recording that
  does not replay fails its step with `REPLAY_STALE` and makes no model call
  (§13.1). The step waits for the recorded control first, 14 s in the
  measurement, so a stale suite is slow as well as red. CI needs no key and no
  login.
- **A step that was never recorded is not stale.** It runs live even under
  `--strict-cache`: a new behaviour, or one whose regenerated title is new
  (§13.5), whose recording was not committed. With no login in CI that step
  fails with `MODEL_PROVIDER_FAILED` (§13.1). It is red either way, and the
  error names a login where the remedy is a recording to commit. The run's exit
  code tells the two apart: 3 for this, 2 for `REPLAY_STALE`.
- **A stale recording is not a verdict.** `REPLAY_STALE` covers a control that
  was renamed and also an action the app now rejects or an end state it no
  longer reaches, which the runner's guide calls a possible regression. The
  skill tells the agent to run the test live before anything else. A live run
  that passes records again, and the changed recording is committed with the
  page change. A live run that fails is a finding under §5's rule, and no
  recording is replaced to make it pass.
- **A recording with a gap never replays whole.** An action the runner cannot
  repeat (a value the agent read off the screen or a screenshot, or worked out
  from the date) runs live on every run, under `--strict-cache` too, and so
  does a truncated recording. Such a test cannot pass in CI without a login.
  The instruction rule of §13.5 puts every value in a parameter, which the
  runner replays; a behaviour that still records a gap is reworded or left
  out of CI, and the run's summary names it.
- **An upgrade** of the runner may re-key every recording (§13.3). The
  `@guren/cli` release that moves the versions says so.

#### 13.7 What the agent can reach

- The `@e2e-dev/acp` presets give the agent the step tools only: no built-in
  tools, no user or project settings, no MCP servers, a session in an empty
  temporary directory, and `POLICY_DENIED` on any tool of its own.
- The config loads no `.env`, and under Bun that is not enough: Bun loads the
  app's env files into the runner and again into the agent's adapter, so the
  agent was started with the app's key and its mail and database settings
  (§13.1). The config therefore parses the names those files set, deletes each
  from `process.env`, and gives the executor each name as an empty string,
  which Bun's loader does not replace. A name the shell also exports is
  emptied with the rest; the agent needs none of them. The app is unaffected:
  `browser:serve` starts it, and it loads its own files. That is the whole
  guarantee: the agent's process inherits the rest of the shell's environment,
  so a secret the shell exports under a name no env file sets, other than
  `E2E_USER_*` or `E2E_SECRET_*`, reaches it, as the runner documents.
- The runner types a credential itself and gives the agent its name only.
  The browser account's password has one source, `BROWSER_TEST_PASSWORD`, the
  variable the seeder of §6 reads: from the shell when it is set there, else
  parsed from the app's env files and never exported. The config hands that
  value to the app through `command.env`, so the seeded hash and the typed
  password cannot differ, and registers it as the credential. Deleting it from
  `process.env` did not keep it from the agent, since the adapter loads the env
  files again (§13.1); the empty value above does. The runner's
  own `E2E_USER_BROWSER_PASSWORD` override is not supported: it changes what
  is typed and not what is seeded.
- With the password unset ~~the signed-in tests are skipped with that reason
  and~~ no default is seeded (§6); the config then registers no credential,
  since the runner refuses a password under six characters when it loads.
  **Amended in implementation:** the runner refuses `test.skip` inside a setup
  test, since other tests depend on its session. The setup therefore fails
  naming `BROWSER_TEST_PASSWORD`, the runner skips every test that needs the
  session with the cause `setup-failed`, and the run exits 1. A password
  shorter than six characters is handled the same way, so the config still
  loads. Measured on the measurement app: the setup failed, the four signed-in
  tests were skipped for it, and the run exited 1.
- A behaviour's input is the plan's. It is committed with the plan and with
  its `TestApp` test, the spec passes it to the agent as ordinary parameters,
  and a recording stores what was typed. A plan therefore holds test values
  only, as it already must.
- Screenshots the runner sends the model mask password fields only. The
  account exists only in a database `browser:serve` judged local, which is what
  bounds what a screenshot can show.

#### 13.8 What changes in §§5 to 11

| Section | Change |
| --- | --- |
| §5 skill | When `e2e.browser.config.ts` exists: run `test:behaviours` after changing a page a behaviour starts on; on `REPLAY_STALE` run the test live first, commit the new recording when it passes, and report a finding under §5's rule when it fails (§13.6). The live drive is unchanged, and the skill still registers no MCP server |
| §6 blueprint | `--behaviours --agent`; `browser:map` owns `tests/browser/behaviours/generated/` under §13.5's conditions |
| §7 evidence | Unchanged. The runner's `.e2e/report.json` stays where it writes it, and `browser:record` reads none of it. The file is the runner's own document (`schemaVersion: "report-1"` in 0.23.1, its JSON schema shipped in the package), so anything that reads it later checks that field: the format moves with the runner's version, which §13.3 pins |
| §8 gates | Unchanged: no gate reads a behaviour spec |
| §9 delivery | M6: the acceptance below holds on the measurement app |
| §11 non-goals | "no agentic test runner" becomes "no agentic test runner in the default install, in any `@guren/*` package or in any gate"; "No model calls from Guren" stands |
| Alternatives | The tester-army/e2e paragraph gains a note pointing here |

#### 13.9 Acceptance for this amendment

- `browser:map` writes a behaviour spec only when the manifest declares `e2e`
  and `@e2e-dev/web` and `e2e.browser.config.ts` exists, removes it when either
  goes, and prints why.
- On the measurement app with one approved plan, on Bun 1.4.4 and the released
  runner: a behaviour's test records in one live run under a Claude Code login,
  and the next run replays every step with no model call.
- With no login and the recordings present, `test:behaviours:ci` passes, and
  its summary shows every step replayed and none run live. After a control is
  renamed on the page with the plan unchanged, it fails that step with
  `REPLAY_STALE` and makes no model call. After the plan's label changes and
  the spec is regenerated, the test has another title and no recording, so it
  fails with the agent's authentication error, as any behaviour with no
  recording does; the guide says that this means a recording to make.
- A behaviour with no pin of §13.5 is a skipped test naming why.
- `NODE_ENV=production bun run test:behaviours` starts no app.
- A behaviour whose start page has a path parameter and no `given.ts` entry is
  skipped with that reason. A behaviour of a kind §13.5 leaves out is a skipped
  test naming why.
- A regenerated test whose start route or instruction changed has another
  title, and its first run records rather than repairs.
- No generated instruction holds a URL, and no generated spec holds
  `agent.assert`.
- After a run that ends, fails or is interrupted, no process of the app or of
  `browser:serve` is left. The config leaves `shutdownTimeout` at the runner's
  10 s, since a `browser:serve` that is force-killed before it handles
  `SIGTERM` leaves the app running (§13.1). A run that finds the port answering
  refuses with `APP_ALREADY_RUNNING` and attaches to nothing.
- The agent's adapter and the agent are started with no value from the app's
  env files: each name those files set is absent or empty in their
  environment, `BROWSER_TEST_PASSWORD` included, whether or not the shell
  exported it, under Bun as under Node.
- A `validation` behaviour that leaves a required key empty is a skipped test
  naming why, and a redirect to `/posts/:id` fails while the browser is on
  `/posts/create`.
- `POLICY_DENIED` is counted over at least fifty live steps before the
  blueprint ships, and its cause is named or its rate stated in the guide.
  Counted on 2026-11-14 (§13.1): none in 65 live steps of the generated shape,
  which by the rule of three puts the rate under 4.6% at 95% confidence. The
  cause of the one earlier failure is not named, so the guide states the rate.

Three items were added at acceptance. Nothing in §13.1 covers them:

- **Codex.** Every agent step in §13.1 ran on Claude Code. Before
  `--agent codex` is offered, a test records in one live run and replays with
  no model call under it, and `POLICY_DENIED` is counted over at least fifty
  live steps. Until then `--agent codex` refuses and says it is not measured.
- **A CI runner.** Every run in §13.1 was on macOS. On the Linux runner CI
  uses, `test:behaviours:ci` replays recordings made on macOS with no model
  call and no login.
- **The agent's environment after it starts.** §13.1 read the environment each
  process is started with. Either what the agent's process loads afterwards is
  checked too, or the guide says that it was not.

#### 13.10 Alternatives considered

**Write the Playwright steps from the plan.** Where the view's form labels
every input key, `getByLabel(label).fill(value)` and a click on the named
action need no agent and no second runner. It breaks on what the plan does not
say: a `select`'s option, a checkbox, a date or file control, a `confirm()`, a
form that appears after a click. Each needs a rule in the generator and a
`fixme` where the rule runs out, and every markup change is a failing test
someone edits by hand. It remains the fallback if §13.9 does not hold in M6,
and is the stronger choice for an app whose forms are all plain text.

**Make the runner the engine of every spec.** The smoke, view and
accessibility specs need no agent, were measured for M4 on Playwright's runner,
and `@axe-core/playwright` runs there. Moving them would restart that
measurement for no gain.

**Leave behaviours to the live drive.** It already performs them, with evidence
(§7). It runs when an agent is asked to, not on every change.

**An API key in CI in place of recordings.** It lets a stale recording repair
itself, and it makes every CI run of a changed page a paid call whose result
depends on a model. A failing `REPLAY_STALE` is the cheaper signal.

**Start the app through `reuseExisting` and a session's `browser:serve`.**
Faster locally, but a run would then attach to a server it did not start,
which §6 rules out for the Playwright config for the same reason.

## Alternatives Considered

**Adopt tester-army/e2e as the engine.** Its replayed agent steps suit flows that
change often, and the skill may name it as a live-drive option. As the default
it would require a model key for agent steps in CI, and the 0.20 package declares
Node engines only. The map, serve and doctor here are engine-neutral, so
adopting it later costs a spec template, not a redesign.
**Amended in §13 (2026-11-14):** adopted as an option an app chooses for
behaviour specs, never as the engine of the generated smoke, view and
accessibility specs. Both reasons above were measured again: a committed
recording replays in CI with no key, and 0.23.1 runs under Bun 1.4.4.

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
   **Resolved (M3):** yes. `test:browser` is `playwright test`, which runs under
   the package's Node shim, and the CLI guide says Node 20.12 or later has to
   be on `PATH` (the config loads the env files with `process.loadEnvFile()`). The
   app itself still runs under Bun, started by `browser:serve`.
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
   **Resolved (2026-10-16):** the graph. The introspection child already knows
   which routed classes are exports of the framework module the app loads, and
   tags those routes with the package (`controllerPackage` on the CLI's route
   entry). The graph then gives such a route a `handles` edge to a controller
   node with no file, its evidence naming the package, so `handles` stays
   complete. A controller from any other package is still unresolved: nothing
   proves where it lives. The map lists a package-handled route in the index as
   handled outside the app, never as a gap.
10. (§12) Should an app be able to accept a known accessibility violation
    without disabling its rule everywhere, and keyed by what, when selectors
    change with every markup edit? A rule id per page is coarse; a selector is
    stale by the next refactor.
11. (§12) Should the screenshot comparison look at pixels? It needs a PNG
    decoder in `@guren/cli` and a threshold. Measuring first how often digests
    differ at the same commit on the measurement app says whether bytes are
    too noisy to be worth reading.
12. (§12) Should the `a11y` spec also check the states a plan's
    `views[].states` names (a form showing its 422 errors, an empty list)? A
    visit reaches only the landing state; another state needs a drive the map
    does not describe yet.
13. (§13) How is replay measured nightly with no model key? The measurement
    app is scaffolded fresh each night and has no recordings. Committing its
    recordings as a fixture makes every scaffold change read as a stale
    recording; giving the nightly a key makes it a paid run. To be decided
    before M6 is done.
14. (§13) Should the generator write plain Playwright steps where the view's
    form labels every input (§13.10) and an agent step only where that rule
    runs out? One suite would then hold two kinds of step, and the app would
    still install the runner for the second.
15. (§13) Nothing removes the recording of a title `browser:map` no longer
    generates, and `e2e cache clear` removes every recording. Should
    `browser:map` delete them, which means reading the runner's own cache
    format, or is that the runner's to offer?
16. (§13) No other agent runner was measured. Is a comparison needed before a
    blueprint names a dependency this young?
17. (§13) `e2e explore`, its bug bash and `e2e mcp` were not measured. Should
    the skill name any of them as a live-drive option, as the Alternatives
    section allowed for?

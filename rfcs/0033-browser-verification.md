# RFC: Browser Verification for the Agent Harness

**Author:** Guren contributors
**Date:** 2026-10-14
**Status:** Accepted (2026-10-15; the deciding maintainer asked for implementation to start
and shortened the standard discussion period.) The amendment in §12 (accessibility checks and
visual change between runs) was accepted on 2026-10-31.

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

No model calls from Guren, no agentic test runner, ~~no visual regression~~ no
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

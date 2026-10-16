# CLI Reference

Guren ships with two companion CLIs:

- `bunx guren` for generating controllers, models, views, and running framework utilities inside an existing project.
- `bunx create-guren-app` for scaffolding a brand-new application.

## Basic Usage

```bash
# No global install required—run directly from the project root.
bunx guren --help
```

Commands follow a subcommand pattern such as `bunx guren make:controller UserController`.

## High-Level Scaffolds

`bunx guren add <feature>` adds a feature the way the starter app has it: it creates the provider, config and runtime files and patches `src/app.ts` to use them. Reach for it before the lower-level `make:*` generators.

```bash
bunx guren add auth
bunx guren add admin
bunx guren add resource posts --fields "title:string,body:text,published:boolean"
bunx guren add queue
bunx guren add mail
bunx guren add events
bunx guren add cache
bunx guren add notifications
bunx guren add storage
bunx guren add attachments
bunx guren add session
bunx guren add broadcasting
bunx guren add schedule
bunx guren add lint
bunx guren add prototype
bunx guren add ai --provider anthropic
bunx guren add oauth
bunx guren add browser-tests
```

Start with `bunx guren add auth` and `bunx guren add resource`, then add more features as your app grows.

### Installing a plugin

```bash
bunx guren plugin @acme/guren-plugin-audit
```

`plugin` (also available as `add plugin`) installs the package with `bun add` when missing (pass `--no-install` to skip), verifies the plugin's declared Guren compatibility (`--ignore-compatibility` to override), wires the provider into `src/app.ts`, and applies any config stubs and env keys the plugin declares in its `gurenPlugin` manifest. `--force` overwrites already-published files.

### `add admin`

`bunx guren add admin` scaffolds:

- `app/Http/Controllers/Admin/AdminDashboardController.ts`
- `resources/js/pages/admin/Dashboard.tsx`
- `routes/admin.ts` (and auto-wires `routes/web.ts` when present)

The dashboard is **authenticated by default**: `routes/admin.ts` attaches
`requireAuthenticated({ redirectTo: '/login' })` to `/admin`, and the controller
calls `this.auth.userOrFail()`. Unlike `make:feature --public`, which only
affects mutating actions, `--public` here opens the whole dashboard:

```bash
bunx guren add admin --public
```

You can run `add admin` before `add auth`. The guard still holds: an app with no
authentication configured has no signed-in user, so every request is redirected
to `/login`, a route that only exists once you run `bunx guren add auth`. Add
authentication first if you want a usable dashboard, or pass `--public` and add
your own check later.

### `add resource`

`add resource` needs the two files it patches to be there: it appends its table to `db/schema.ts` and registers the CRUD
routes in `routes/web.ts`, and unless those routes are registered already,
`routes/web.ts` must export a route registrar it can patch. When one of those is
missing, the command names it and writes nothing, rather than leaving a scaffold
behind and a table appended for routes that were never registered. Use
`bunx guren make:feature` instead if you want the files without the two patches;
it prints the route block to paste and tells you which schema file to add the
table to.

### `add prototype`

`add prototype` installs prototype mode ([Prototype First](./prototype-first.md)): a
fixture under `resources/js/prototype/` that answers Inertia visits from seed data, the
`dev:prototype` and `build:prototype` scripts, and the two loader lines in
`resources/js/app.tsx` and `src/app.ts`. `--remove` takes the scripts and the loaders
back out. `make:feature <Entity> --fields "…" --prototype` then writes the visible half
of a feature only, pages, validator, a page-data type and fixture entries, and prints the
routes to register on the `prototype` handler. Run the same command without the flag
once that page-data type exists (`resources/js/types/<Entity>.ts`) and it promotes the
feature: model, Resource and controller, with the Resource typed against the page-data
type, and the pages and validator left as they are. `bun run build:prototype` runs `check --prototype` before Vite, so a route with
no fixture entry fails the build rather than the customer's click.

### `add ai`

`add ai` sets up in-process AI agents with `@guren/plugin-ai`. It writes `config/ai.ts`
for one provider (`--provider anthropic`, `openai` or `gateway`), declares that
provider's API key in `config/env.ts` and the env files, and registers the config and
`aiPlugin()` in `createApp()`. It then runs `bun add` for the plugin, `ai` and the
provider package (`gateway` needs none); `--no-install` prints the command instead. The key is optional, so
the app boots without it and the first prompt fails. The command needs a
`config/env.ts`. In an app with a `db/schema.ts`, it also adds the
`ai_conversations` and `ai_messages` tables, generates their migration, and
configures `config/ai.ts` to keep conversations in them; `--no-conversations` skips
that. The tables hold each transcript as the model saw it, tool results included, so
treat them as sensitive data. `make:ai-agent <Name>` then writes an agent class to
`app/Ai/Agents`. `--tools` hands it the named agent tools after checking that a route
derives each one, `--output` adds a structured-output schema stub, and `--test` writes
a test that scripts the model with `app.fakeAi()`. [AI Agents](./ai-agents.md) covers
the rest: scopes, conversations, streaming and queueing.

### `add lint`

Apps scaffolded by `create-guren-app` 1.12 or later already carry this setup; `add lint` is for apps created before that. It touches no application code: it writes `.oxlintrc.json` (oxlint with the Guren rules from `@guren/cli/oxlint`: `guren/await-async-assertion` as an error, `guren/no-unvalidated-env-read` as an error in `app/`, `config/`, `routes/`, `src/` and `modules/`, the `guren/comment-*` rules as warnings), adds `lint` and `lint:fix` scripts, and adds `oxlint` as a dev dependency on a tilde range (patch updates only: oxlint's JS plugin API is alpha); run `bun install` afterwards. `bunx oxlint` runs under Bun, so no Node install is needed. In an app created before `config/env.ts`, the rule also reports the `process.env` reads in its own `config/database.ts` and `src/app.ts` until they move to a schema or carry a disable.

### `add browser-tests`

`add browser-tests` sets up Playwright browser tests. They start your app through `bunx guren browser:serve`, which refuses production and any database it cannot show is local. The command writes `playwright.browser.config.ts`, which starts the app on `127.0.0.1:4317`, and `tests/browser/support.ts`, then runs `bunx guren browser:map`, which from then on keeps two kinds of spec under `tests/browser/generated/`:

- `smoke.browser.ts`, one test per feature in the browser map: the feature's first page without a path parameter must answer 200 with the component its route renders;
- `plans/<plan>.browser.ts` for each approved plan with views: every form label and action name the plan gives a view must be visible on the first page without a path parameter that renders it.

A page the specs cannot open (every route to it takes a parameter, no route renders it yet, or it needs a signed-in user the app cannot provide) becomes a `test.fixme` that says why, so it shows up as skipped rather than passing. Run `bunx guren browser:map` again after approving a plan; `--check` exits 1 while a generated spec is out of date. It removes a generated spec no feature or plan produces any more, and refuses to overwrite a file under `tests/browser/generated/` that lacks the generated header, so put specs of your own beside that directory.

When the app signs in with a password (the `users` table `make:auth` writes and a `POST /login` route), the command also writes a setup project, `tests/browser/auth.setup.ts`, and a seeder, `db/seeders/browser-account.ts`. The seeder creates `browser@example.test` with the password in `BROWSER_TEST_PASSWORD` while `browser:serve` runs the app, and does nothing in any other run or in production. Set `BROWSER_TEST_PASSWORD` in `.env` before the first run. The seeder runs through boot-time seeding, so `config/database.ts` has to pass `seedOnBoot` to `defineDatabaseConfig()`; the command warns when it does not.

It adds a `test:browser` script (`playwright test -c playwright.browser.config.ts`) and the `@playwright/test` dev dependency (`--no-install` prints the `bun add` command instead), and adds `test-results/`, `playwright-report/` and `tests/browser/.auth/` to `.gitignore`. A `test:browser` script that runs something else makes the command stop before writing anything; `--force` replaces it. Install a browser with `bunx playwright install chromium`, then run `bun run test:browser`. Playwright runs under Node, so Node has to be on `PATH`.

Spec files end in `.browser.ts`, because `bun test` collects `*.spec.ts`. `guren gate` does not run browser tests.

### On an API-only app

An app scaffolded from the `api` blueprint has no `@guren/inertia-client` dependency and no web routes entry (`routes/web.ts` or `routes/web.js`). Commands that would write Inertia pages react to those two signals:

| Command | On an API-only app |
|---------|--------------------|
| `add admin` | Refuses and writes nothing. Write an admin endpoint with `make:controller` and register it in `routes/api.ts` |
| `add auth`, `make:auth` | Refuses before patching `db/schema.ts` or generating a migration. For a token API, guard `routes/api.ts` with `createBearerTokenMiddleware` and issue tokens with `createApiToken` (see the [API tokens guide](./api-tokens.md)) |
| `add resource`, `make:feature` | Refuses before appending the table. Write a JSON controller with `make:controller` and wire it into `routes/api.ts` |
| `make:view` | Refuses: a page has no JSON shape to adapt to |
| `add prototype` | Refuses: prototype mode answers Inertia visits |
| `add browser-tests` | Refuses: the specs drive Inertia pages. Test the routes over HTTP with `TestApp` |
| `make:controller` | Adapts: the controller returns `this.json(...)` and can be wired into `routes/api.ts` as written |

When the signals cannot confirm an API-only app, every command behaves as on a fullstack one. Installing `@guren/inertia-client` is enough to switch back. `guren codegen` leaves page components out of `.guren/pages.gen.ts` on an API-only app, because that file imports `@guren/inertia-client`; `make:view`'s refusal exists to say so at the command that caused it.

### When files already exist

`add resource` and `make:feature` look for every file they would write before
writing the first one. When some are already there (a model you wrote by hand, say), the command
lists each of them and writes nothing, and `add resource` leaves `db/schema.ts` and
`routes/web.ts` unpatched. `--force` overwrites every file on that list, your own
among them. A file that only `--test`, `--factory` or `--policy` adds is marked
with its flag, and dropping the flag gets past it. Promoting a prototype keeps the
pages and validator the prototype run wrote, so those never count.

Every other command that writes several files refuses the same way before its first
write: `make:auth`, `make:module`, `make:ai-agent` (where `--test` is the flag),
`deploy`, and the `add` blueprints, their sample event, job or mailable included. A
single-file `make:*` command refuses in the same words. The blueprints meant to be
re-run to repair a partial install (`add session`, `add cache`, `add schedule`,
`add ai`, `add prototype`) keep the files already there and write the rest instead.

## Core Commands

| Command | Description | Example |
|---------|-------------|---------|
| `key:generate` | Generate a new `APP_KEY` value. Use `--write` to save it to `.env` | `bunx guren key:generate --write` |
| `deploy` | Generate deployment recipe files for Docker/Fly.io/Railway | `bunx guren deploy --target all --app my-app --port 3333` |
| `make:controller <Name>` | Generates a controller in `app/Http/Controllers` (returns JSON instead of an Inertia page on an API-only app) | `bunx guren make:controller PostController` |
| `make:model <Name>` | Generates a minimal model class and type definition in `app/Models` (imports `camelCase(Name)s` from `db/schema`) | `bunx guren make:model Post` |
| `make:view <path>` | Generates a React component in `resources/js/pages` (refuses on an API-only app) | `bunx guren make:view posts/Index` |
| `make:auth` | Scaffolds login/logout, registration, and password reset controllers, providers, views, migration, seeder, and routes (`--minimal` skips registration and password reset, `--verify` also scaffolds email verification, `--oauth <providers>` also scaffolds OAuth login buttons for the given comma-separated providers, `--oauth-only` drops password login entirely and makes those providers the only way in) | `bunx guren make:auth --oauth github,google` |
| `make:middleware <Name>` | Generates a middleware file in `app/Http/Middleware` | `bunx guren make:middleware Auth` |
| `make:policy <Name>` | Generates an authorization policy in `app/Policies` with owner-based defaults | `bunx guren make:policy Post` |
| `make:validator <Name>` | Generates Zod validation schemas (route params, list query, payload) in `app/Http/Validators`; `--fields` uses the same syntax as `make:feature` | `bunx guren make:validator Post --fields "title:string,body:text"` |
| `make:adr "<Title>"` | Records an architecture decision as a numbered file under `docs/adr/` with linkable frontmatter; `--entity <Model>` prefills the `entities:`/`related:` links, `--issue <ref>` (comma-separated for several) the `issues:` link to a GitHub issue or PR | `bunx guren make:adr "Billing cycle is end-of-month" --entity Invoice --issue 412` |
| `make:seeder <Name>` | Generates a database seeder file | `bunx guren make:seeder UserSeeder` |
| `make:job <Name>` | Generates a queueable job class, its `jobName` pinned to the class name | `bunx guren make:job SendEmail` |
| `make:event <Name>` | Generates an event class | `bunx guren make:event UserRegistered` |
| `make:listener <Name>` | Generates an event listener class | `bunx guren make:listener SendWelcomeEmail` |
| `make:notification <Name>` | Generates a notification class, its `type` pinned to the class name | `bunx guren make:notification InvoicePaid` |
| `make:mail <Name>` | Generates a mailable class | `bunx guren make:mail WelcomeEmail` |
| `make:command <Name>` | Generates a console command in `app/Console/Commands`; `--command <name>` sets the invocation name. Register it in `src/console.ts` — see the [console commands guide](./console.md) | `bunx guren make:command SendDigest --command reports:digest` |
| `make:ai-agent <Name>` | Scaffolds an in-process AI agent in `app/Ai/Agents` (`@guren/plugin-ai`). `--tools` grants route-derived agent tools, `--output` adds a Zod output schema, `--test` writes a `fakeAi()` test | `bunx guren make:ai-agent SupportTriager --tools tickets_show --test` |
| `make:agent <Name>` | Scaffolds a durable agent in `app/Agents`, registers it in `config/agents.ts`, adds the `guren.arch.ts` rule that keeps it off your models and ORM, and writes the `config/bindings.ts` and tsconfig `types` entry its class needs — see [Durable Agents](./durable-agents.md) | `bunx guren make:agent Triager` |

> **Note:** `make:*` commands avoid overwriting existing files. Use `--force` if you need to replace them.

## Inspection & Audit Commands

Validate your app before shipping. These commands are also designed for AI coding agents (add `--json` for machine-readable output).

[Checks and Audits in Depth](./cli-checks.md) explains the rules behind these commands, and how to suppress a false positive.

| Command | Description | Example |
|---------|-------------|---------|
| `check` | Validate the app's wiring (the full list follows the table) | `bunx guren check --json` |
| `audit` | Security audit: missing input validation, authentication or policy authorization on mutating routes, raw SQL with interpolation, hardcoded credentials, disabled security defaults, mass-assignment configuration, sensitive columns not listed in `hidden`, emailed links built from the request host, CSRF exemptions declared by the app or by an installed package, and in-process agents' local tools | `bunx guren audit --json` |
| `gate` | Every verification stage the scaffolded CI runs — codegen, typecheck, lint, `check` (the `--ci` rule), `audit`, tests — reported together; exits non-zero if any stage fails, and a stage that cannot run fails rather than skips | `bunx guren gate --changed` |
| `introspect` | Registers the app's providers and routes without booting or listening, then prints the manifest: providers and how each registered, routes with resolved middleware and controller files, the session, auth, cache, storage, queue and attachments configuration, and whether the database is local (never its connection string) | `bunx guren introspect --json` |
| `doctor` | Project health report (env, config, generated files) with actionable next steps | `bunx guren doctor --next` |
| `context [Entity]` | Project context map — or, with an entity name, everything about one model: table, relationships, `fillable`/`hidden`/`visible`/`casts`, routes with schemas (matched by `<Entity>Controller`, a `bind` naming the model, or an action body that uses it), pages with Props, resource, policy, linked docs and issues (`--module` disambiguates, `"app"` = project root; `--live` asks `gh` for issue state, `--repo owner/name` overrides the origin remote) | `bunx guren context User --json` |
| `docs:graph` | The OKF docs relation graph: documents, entities, and code paths as nodes, verified relations as edges. `--entity <Model>` or `--path <file>` narrows to a neighborhood — ask "what governs this?" before renaming | `bunx guren docs:graph --path app/Http/Controllers/PostController.ts` |
| `spec:generate` | Regenerates the derived spec views in `docs/spec/` (ER diagram, domain model, screens, module map) — see [Spec-Anchored Development](./spec-anchored.md) | `bunx guren spec:generate` |

`audit` recognizes routes wrapped in named middleware (for example `router.middleware('auth').group(...)`) as protected, and leaves guest flows such as `/login` and `/register` out of its authentication checks.

### What `check` covers

`check` covers:

- routes, controllers, pages and models agreeing with each other;
- every file in `routes/` being reached from your entry registrar, and every file in a module's `routes/` from that module's own registrar;
- the durable-agent registry in `config/agents.ts`, and in-process agents' `appTools()` names and scopes;
- deferred Inertia props: a `defer()` passed for a prop the page's `Props` declares as required (advisory);
- doc links, spec-view freshness and architecture boundaries;
- for an app that declares a deploy plugin or the Lambda adapter, the deploy-runtime verdicts `guren doctor` reports (advisory).

### Exit codes and suite flags

`audit` exits with a non-zero status when it finds failures. Plain `check` is informational. Its suite flags each exit non-zero on
failures in that suite, and `gate` (below) is what the scaffolded CI
workflow runs:

```bash
bunx guren audit
bunx guren check --arch    # architecture boundaries (guren.arch.ts + module rules)
bunx guren check --docs    # doc links: OKF frontmatter (type/entities/related) + body links + @docs tags
bunx guren check --spec    # docs/spec/ views match a fresh regeneration
bunx guren check --prototype  # routes on the prototype handler have a named fixture entry, and the loaders are wired
```

Combining suite flags runs their union. `--changed` restricts any of
them to files changed against the merge base with `main`, the fast
path the agent harness's [edit hook](./agent-harness.md#hooks) uses.

### Regenerating with `--fix`

Some findings clear by regenerating files: a missing `.guren/*.gen.ts`
manifest (`guren codegen`) and a drifted `docs/spec/` view
(`guren spec:generate`). `check --json` gives each of these a `fix`
field, `{ "kind": "command", "args": ["codegen"] }`, holding the
arguments after `guren`. `--fix` runs every distinct fix once, then
checks again and reports that second run, with what it ran under
`fixes`. It exits non-zero when one of the commands fails, or exits 0
while the findings it was meant to clear are still reported. `--fix`
is refused under `--ci`: a gate that regenerated the drift it checks
for would always pass, so run it locally and commit what it writes. A
finding that needs a code change or a decision has no `fix`, only the
`suggestion` text.

```bash
bunx guren check --fix          # regenerate what the findings name, then check again
bunx guren check --spec --fix   # the same, limited to the spec views
```

`doctor --fix` regenerates the missing or stale generated manifests reported
by doctor, then runs doctor again in a fresh process. It selects the app's
route entry, including `routes/api.ts`, and runs each distinct generator once.
`doctor --json` exposes these repairs as `repair: { kind: 'command', args }`;
with `--fix`, the final report also includes `fixes`. A failed command or a
repair finding that does not pass recheck makes the command exit nonzero.
An unavailable recheck also counts as failure. Other warnings remain in the
report; `--strict` makes those warnings and failures set the exit code.
Configuration autofixes marked `canAutofix` still belong to `guren upgrade`.
This flag only rewrites generated files.

```bash
bunx guren doctor --fix --next
bunx guren doctor --fix --json
```

### `gate`

`gate` is the one command that answers "is this change done?". It runs
codegen, typecheck, lint (when the app has an `.oxlintrc.json`),
`check` under the `--ci` rule, `audit`, and the test suite (the stages
the scaffolded CI workflow runs), reports every stage, and exits
non-zero if any failed. A stage that *cannot* run is a failure, not a
skip: an `.oxlintrc.json` with no oxlint installed, a missing
`typecheck` script, a routes entry that will not load. Only an app with
no `.oxlintrc.json` skips lint. The `check` and `audit` stages read the
introspected app: the app's providers and routes are registered in a child
process that never boots it (see [Checks that read the introspected app](./cli-checks.md#checks-that-read-the-introspected-app)).
That happens once per run, capped at 10 seconds, after codegen, so a fresh
clone's entry imports by then.

Two kinds of result are printed as [advisory](./glossary.md#plan-states)
lines, which never fail the gate:

- an introspection that fails adds one line to the stage that asked for it;
- each `-unverified` result (a verdict only the app could give, which
  introspection could not confirm) is printed on the check stage, naming why.
  A `--changed` run that changed no source does not introspect, so it prints
  none.

`guren plan:verify` prints the same lines on its check step.

```bash
bunx guren gate            # every stage, in full
bunx guren gate --changed  # check and lint on changed files only; typecheck, audit, tests still in full
bunx guren gate --deps     # add the dependency scan to the audit stage
bunx guren gate --json     # the per-stage report, for tools
```

The scaffolded `.github/workflows/ci.yml` is one `bunx guren gate --deps`
step, so a change that passes the gate locally passes CI. The agent
harness runs it when a Claude Code, Codex or Cursor turn ends (see
[Agent Harness](./agent-harness.md#hooks)), the MCP server exposes it as
`guren_gate`, and `AGENTS.md` tells every agent that reads it to run it before
declaring a change done.

More on these commands in [Checks and Audits in Depth](./cli-checks.md): the audit's [policy rule](./cli-checks.md#the-audits-policy-rule), what [`introspect`](./cli-checks.md#introspecting-the-registered-app) runs, the extra rules for [agent-exposed routes](./cli-checks.md#agent-exposed-routes) and [in-process agents](./cli-checks.md#in-process-agents), [suppressing a false positive](./cli-checks.md#suppressing-audit-findings), [architecture boundaries](./cli-checks.md#architecture-boundaries), and [how the checks read the app](./cli-checks.md#how-the-checks-read-the-app).

## Application Modules

As an app grows past a couple dozen routes, `guren make:module` gives you a self-contained slice of the app instead of piling everything into one flat `app/`, `routes/`, and `db/schema.ts`:

```bash
bunx guren make:module Billing
```

This scaffolds `modules/billing/{index.ts, routes.ts, db/schema.ts}` and wires it in automatically: `db/schema.ts` gets `export * from '../modules/billing/db/schema'`, and `src/app.ts` gets `billingModule` imported and added to `createApp({ modules: [...] })`.

If your root `db/schema.ts` keeps a schema object for drizzle (`export const schema = { posts, users }`, named `schema` or read by a `typeof`), the module gets one of its own, `export const billingSchema = {}`, and the root object spreads it (`{ posts, users, ...billingSchema }`). Declare the module's tables in `modules/billing/db/schema.ts` and list each one in `billingSchema`. `guren check` reports a table missing from either object, including a module table the root object neither lists nor spreads.

Most `make:*` commands accept `--module <name>` to scaffold inside a module instead of the project root:

```bash
bunx guren make:controller Invoice --module billing   # modules/billing/app/Http/Controllers/InvoiceController.ts
bunx guren make:model Invoice --module billing        # modules/billing/app/Models/Invoice.ts
```

`guren check`, `guren audit`, `guren context`, `model:list`, and `doctor` all scan `modules/*/` automatically, with no extra configuration needed. Two exceptions: `make:auth` (authentication is an app-wide concern, not a per-module one) and `make:migration` (drizzle-kit driven; migrations are generated from whichever schema paths `drizzle.config.ts` points at, module or not).

A module's public API is its `index.ts` (the `defineModule()` descriptor it exports) plus `db/schema.ts` for table definitions shared across modules. Once a `modules/` directory exists, `guren check` enforces this automatically, with no `guren.arch.ts` required: a file inside one module reaching into another module's internals (anything other than its `index.ts` or `db/schema.ts`) is a failure, and so is top-level app code doing the same.

```typescript
// modules/billing/index.ts
import { defineModule } from '@guren/core'
import { registerBillingRoutes } from './routes'

export const billingModule = defineModule({
  name: 'billing',
  prefix: '/billing',            // optional URL prefix for every route the registrar declares
  routes: registerBillingRoutes,
  providers: [BillingServiceProvider],  // optional — appended to the app's provider list
})
```

A module can also carry config definitions for services only it uses: keep them in `modules/<name>/config/` and list them in `defineModule({ config: [...] })`. They bind after the app's `createApp({ config })` and share its keys, so a key defined in both places fails the boot (see [Configuration](./configuration.md#definitions-in-a-module)). `guren check` reads that list as wiring for any module `createApp({ modules })` lists.

Inertia pages are not colocated inside `modules/<name>/`. They stay under the top-level `resources/js/pages/`, namespaced by module name instead (`resources/js/pages/billing/Invoices/Index.tsx`). `make:feature Invoice --module billing` follows this convention automatically.

## AI Agent Harness

Apps scaffolded with `create-guren-app` include an agent harness: project guides, rules, skills and an MCP config for Claude Code, Codex, Cursor, GitHub Copilot and OpenCode, plus hooks for the agents that support them. [Agent Harness](./agent-harness.md) lists the files each agent gets and how the hooks work.

| Command | Description | Example |
|---------|-------------|---------|
| `agent:init` | Install the agent harness for the selected agents into an existing app (skips files that already exist; `--force` overwrites) | `bunx guren agent:init --target codex,cursor` |
| `agent:sync` | Refresh framework-managed files (rules, skills, subagents, hooks) for every agent detected on disk | `bunx guren agent:sync` |

## Deployment Recipes

Generate deployment config files directly from the CLI:

```bash
# Dockerfile only
bunx guren deploy

# Fly.io (Dockerfile + fly.toml)
bunx guren deploy --target fly --app my-app

# Railway (Dockerfile + railway.json)
bunx guren deploy --target railway

# Generate all recipes at once with a custom port
bunx guren deploy --target all --app my-app --port 4000
```

Supported targets are `docker`, `fly`, `railway`, and `all`. When a file it would write already exists, the command lists every such file and writes none; pass `--force` to overwrite them.

Vercel and AWS Lambda use plugins, installed with `bunx guren plugin @guren/plugin-vercel` and `bunx guren plugin @guren/plugin-lambda`, and `--target vercel` is rejected. [Deployment](./deployment.md) walks through both.

## OpenAPI Commands

| Command | Description | Example |
|---------|-------------|---------|
| `openapi:generate` | Generate an OpenAPI 3.1 document from route definitions | `bunx guren openapi:generate` |

Requires the optional `@guren/openapi` package (`bun add @guren/openapi`).

### openapi:generate Options

```bash
# Generate with defaults (reads routes/web.ts, writes .guren/openapi.gen.json)
bunx guren openapi:generate

# Custom title, version, and description
bunx guren openapi:generate --title "Blog API" --version "1.0.0" --description "My blog"

# Custom routes file and output path
bunx guren openapi:generate --routes routes/api.ts --out docs/openapi.json

# Include a server URL
bunx guren openapi:generate --server "https://api.example.com"

# Overwrite existing file
bunx guren openapi:generate --force
```

| Flag | Default | Description |
|------|---------|-------------|
| `--routes` | `routes/web.ts` | Path to the route registration file |
| `--out` | `.guren/openapi.gen.json` | Output path for the generated document |
| `--title` | `package.json` name or `"Guren API"` | OpenAPI document title |
| `--version` | `package.json` version or `"1.0.0"` | OpenAPI document version |
| `--description` | `package.json` description | OpenAPI document description |
| `--server` | — | Server URL to include |
| `--app` | Current directory | Application root directory |
| `--force` | `false` | Overwrite existing files |

The command extracts Zod schemas and OpenAPI metadata (`summary`, `description`, `tags`, `operationId`, `deprecated`) from route contracts and produces an OpenAPI 3.1 JSON document. See [Routing — OpenAPI](./routing.md#openapi-document-generation) for details on annotating routes.

## Route Commands

| Command | Description | Example |
|---------|-------------|---------|
| `route:list` | List all registered routes | `bunx guren route:list` |

### route:list Options

Display all application routes with filtering and sorting capabilities:

```bash
# List all routes
bunx guren route:list

# Filter by HTTP method
bunx guren route:list --method GET

# Filter by path pattern
bunx guren route:list --path users

# Filter by route name
bunx guren route:list --name admin

# Sort routes
bunx guren route:list --sort path
bunx guren route:list --sort method
bunx guren route:list --sort name

# Reverse sort order
bunx guren route:list --sort path --reverse

# Output formats
bunx guren route:list --format table   # Default table format
bunx guren route:list --format json    # JSON output
bunx guren route:list --format compact # Compact single-line format
```

## Agent Tool Commands

Routes that declare `.agent()` metadata are exposed to AI agents as MCP tools (see [Routing — Agent tools](./routing.md)). These commands report what an agent would see, derived live from your route graph rather than read from `.guren/agents.gen.ts`, so they answer correctly even when that manifest is missing or stale.

| Command | Description | Example |
|---------|-------------|---------|
| `tool:list` | List the agent tools this application exposes | `bunx guren tool:list` |
| `tool:inspect` | Show one tool's full derivation | `bunx guren tool:inspect posts.store` |
| `tool:call` | Invoke one tool the way an agent would | `bunx guren tool:call posts.index` |
| `tool:dev` | Serve the tools locally with a throwaway token | `bunx guren tool:dev` |
| `tool:log` | Read the agent audit trail | `bunx guren tool:log --tail` |

```bash
# Every exposed tool, with its method, path, protocol exposure,
# authorization ability and MCP annotation hints
bunx guren tool:list

# The raw derivation, including any warnings
bunx guren tool:list --json

# One tool: input fields, output schema, authorization,
# annotations, approval and redaction
bunx guren tool:inspect posts.store
bunx guren tool:inspect posts.store --json

# Run the app's MCP endpoint locally with a token that lasts only as long
# as the command, and print the MCP Inspector invocation for it
bunx guren tool:dev
bunx guren tool:dev --as 42 --port 4000
```

`tool:list` and `tool:inspect` options:

| Option | Default | Description |
|--------|---------|-------------|
| `--routes` | The app's routes entry: `routes/web.ts`, else `routes/api.ts` — the same probe `check` and `audit` use | Path to the routes entry file |
| `--app` | Current directory | Application root directory |
| `--json` | `false` | Output the derived tools as JSON |

`tool:call` goes one step further and actually invokes a tool, through the same dispatch contract an MCP client's call goes through. It boots the application, so its tools come from the graph the running app serves, which is why it takes no `--routes`.

```bash
# Call a tool with arguments
bunx guren tool:call posts.store --input '{"title":"Hello agents"}'

# Rehearse it: run the middleware and validate the contract, stop before the handler
bunx guren tool:call posts.store --input '{"title":"Hello"}' --preflight

# Call as a user, and read the result as JSON
bunx guren tool:call posts.index --as user:42 --json
```

| Option | Default | Description |
|--------|---------|-------------|
| `--input` | `{}` | Tool arguments as a JSON object |
| `--as` | (unauthenticated) | Authenticate as a user (`user:42`). Development only: sets `GUREN_TESTING=1` for the process, so the app accepts an injected user instead of a real credential, and passwords hash with the cheap test parameters (see [Testing](./testing.md#password-hashing-in-tests)) |
| `--preflight` | `false` | Ask for a verdict instead of an execution — the handler does not run |
| `--app` | Current directory | Application root directory |
| `--json` | `false` | Output the call result as JSON |

The command exits non-zero when the call comes back as an error result, so a 422 or a 403 is not read as a success by a script. See [Agent Interface — Calling a tool yourself](./agent-interface.md#calling-a-tool-yourself).

If the application it boots has an [audit trail](./agent-tool-governance.md#the-audit-trail) configured, the call is recorded in it as `surface: 'cli'` (the same file, the same masking, alongside the MCP records). A call from here runs as whoever `--as` names, with nothing verified, so it is worth being able to see later. An application with no trail configured records nothing and the call is unaffected.

`tool:dev` serves the application's *own* endpoint, so it requires
[`@guren/plugin-mcp`](./agent-interface.md) to be installed and registered, and
says so if no endpoint answers. The token it issues lives in memory for that
process only: nothing is written to your app's token store, and stopping the
command revokes it. It refuses to run with `NODE_ENV=production`.

| Option | Default | Description |
|--------|---------|-------------|
| `--as` | a placeholder id | User ID tool calls authenticate as. The default matches no record, so listing tools works while a call whose policy loads a user fails visibly |
| `--path` | `/mcp` | Endpoint path, when the plugin is mounted elsewhere |
| `--port` | `3333` | Port to listen on (`0` picks a free one) |
| `--host` | `127.0.0.1` | Hostname to bind |
| `--app` | Current directory | Application root directory |

> [!WARNING]
> The printed token grants `tools:*`. The default bind is loopback, so it stays on your machine; `--host 0.0.0.0` makes the endpoint (and that token) reachable from your network for as long as the command runs.

`tool:log` reads the audit trail back. Unlike its neighbours it boots nothing. An audit trail has to be readable when the application it records is not startable.

```bash
# The last 50 records
bunx guren tool:log

# Follow, including the rollover into tomorrow's file
bunx guren tool:log --tail

# Only denials, only this tool, only the last two hours
bunx guren tool:log --denied
bunx guren tool:log --tool posts.store --since 2h -n 200

# Raw records, one per line, for piping
bunx guren tool:log --json | jq 'select(.status >= 400)'
```

| Option | Default | Description |
|--------|---------|-------------|
| `--file` | `storage/logs/agent-audit.log` | Base path of the trail; dated files sit beside it |
| `--tail`, `-f` | `false` | Follow the trail as records arrive, across the midnight rollover |
| `--tool` | (all tools) | Only records for this tool |
| `--surface` | (all surfaces) | Only `mcp`, `dev-mcp`, `cli`, `webmcp`, `durable`, or `in-process` |
| `--denied` | `false` | Only denials |
| `--since` | (no cutoff) | Only records newer than a duration such as `30m`, `2h`, `7d` |
| `-n` | `50` | How many records to show |
| `--app` | Current directory | Application root directory |
| `--json` | `false` | Output one raw record per line, for piping |

`-n` applies **after** filtering, so `--denied -n 50` is the last fifty denials rather than the denials among the last fifty records. Records only exist once a sink is configured: the trail is opt-in, and the command prints the configuration line to add when it finds none. See [Control and Audit Agent Tool Access — The audit trail](./agent-tool-governance.md#the-audit-trail).

Everything shown is derived from contracts the route already carries: the input schema merges its `params`, `query` and `body` schemas, the output schema comes from `output`, and the authorization ability comes from the policy its middleware chain checks. Nothing is declared twice, so a tool cannot advertise a schema the endpoint does not validate.

`bunx guren codegen` writes the same derivation to `.guren/agents.gen.ts` for apps that expose at least one tool, and removes that file for apps that expose none.

## Config Commands

| Command | Description | Example |
|---------|-------------|---------|
| `config:cache` | Cache all configuration files | `bunx guren config:cache` |
| `config:clear` | Clear the configuration cache | `bunx guren config:clear` |
| `config:show` | Display configuration cache info | `bunx guren config:show` |

### Configuration Caching

Cache your configuration files for improved performance in production:

```bash
# Cache all configuration
bunx guren config:cache

# Clear the cache
bunx guren config:clear

# View cache info
bunx guren config:show
```

The cache is stored in `bootstrap/cache/config.json`. Configuration files are loaded from the `config/` directory (including nested subdirectories).

**Note:** After modifying configuration files, run `config:cache` again to update the cache.

## Database Commands

| Command | Description | Example |
|---------|-------------|---------|
| `db:migrate` | Run pending database migrations | `bunx guren db:migrate` |
| `db:rollback` | Explain how to undo migrations (they only run forward) | `bunx guren db:rollback` |
| `db:reset` | Drop all tables and re-run migrations | `bunx guren db:reset` |
| `db:seed` | Run database seeders | `bunx guren db:seed` |

### db:migrate Options

`db:migrate` applies every pending migration in the folder `config/database.ts` configures as `migrationsFolder` (`db/migrations` in a scaffolded app). It never asks for confirmation, so a deploy pipeline can run it unattended.

```bash
# Run migrations
bunx guren db:migrate

# Show what would happen without executing
bunx guren db:migrate --dry-run

# Output the result as JSON
bunx guren db:migrate --json
```

### db:rollback

Migrations are generated by drizzle-kit and only run forward, so there is no batch to roll back. `db:rollback` takes no options. It prints the alternatives below and exits with a non-zero status, which stops a script that calls it.

- In development, `bunx guren db:reset --seed` drops every table and re-applies all migrations.
- To discard a migration you have not committed, delete its folder under `db/migrations/`, then run `bunx guren db:reset`.
- In production, revert the change in `db/schema.ts` and generate a new migration with `bunx guren make:migration`.

### db:seed Options

`db:seed` runs every seeder in the folder `config/database.ts` configures as `seedersFolder` (`db/seeders` in a scaffolded app), in filename order. There is no option to run a single seeder. Prefix the filenames (`001_`, `002_`, …) when the order matters.

```bash
# Run all seeders
bunx guren db:seed

# Force seeding in production
bunx guren db:seed --force

# Show what would happen without executing
bunx guren db:seed --dry-run

# Emit the run summary as JSON
bunx guren db:seed --json
```

> [!NOTE]
> `--json` covers the command's own summary. Seeder stdout is not suppressed (the `make:seeder` template logs a line per seeder), so silence those before piping to `jq`.

## Queue Commands

| Command | Description | Example |
|---------|-------------|---------|
| `queue:work` | Start processing queued jobs | `bunx guren queue:work` |

### queue:work Options

```bash
# Process jobs from default queue
bunx guren queue:work

# Process specific queue
bunx guren queue:work --queue emails

# Limit number of jobs
bunx guren queue:work --max-jobs 100

# Stop when queue is empty
bunx guren queue:work --stop-when-empty
```

## Shared Options

`make:*` and `add` commands share one writer option:

- `--force` / `-f`: Overwrite files even if they already exist. `add ai` and `add prototype` take `--force` without the `-f` alias.

Run a command from the app's root directory; it acts on the current directory.

## Template Details

Generated files match the Laravel-inspired ergonomics of the framework:

- Controllers extend `Controller` and use helpers like `this.inertia()`.
- Models extend `Model<TRecord>` and prefill `static table`. Use the helpers for quick CRUD, or call Drizzle’s RQB directly. `Model.newQuery().toDrizzle()` lets you start from the model, scopes included, while still writing Drizzle queries.
- Views are React + TypeScript + Tailwind CSS functional components.

After generation remember to wire up routes and connect `static table` to the proper Drizzle schema. Complex queries can go through `toDrizzle()`, which keeps the model's scopes, or skip the model entirely with your Drizzle database (`getDatabase()`).

## Scaffolding New Apps

Use the dedicated bootstrapper when starting from scratch:

```bash
bunx create-guren-app my-app
```

The CLI copies the default template, updates metadata, and prompts for a rendering mode. Choose **SSR** (default) to keep server-side rendering enabled via `autoConfigureInertiaAssets`, or pick **SPA** to disable SSR. Skip the prompt with `--mode ssr` or `--mode spa`, and overwrite a non-empty directory with `--force`.

It also asks which coding agents to install the [agent harness](./agent-harness.md#choosing-agents) for. Answer with `--agents codex,cursor`, or skip the harness with `--agents none`.

## Troubleshooting
- `command not found: bunx`: Your Bun version may be outdated. Install the supported Bun 1.4.2 baseline.
- `Error: Port already in use`: The development server (default port 3333) is occupied. Update `PORT` in `.env` and restart.
- `Database connection failed`: A new app uses SQLite at `./data/guren.db`, so check `DATABASE_URL` in `.env`. On an app created with `--db postgres` or `--db mysql`, make sure the database is running (`bun run db:up`) and that `DATABASE_URL` points at it.

## Interactive REPL

Launch the framework-aware console with:

```bash
bunx guren console
```

> This is an interactive REPL, not your application's commands. To run those, use `bun run console <command>`. See the [console commands guide](./console.md).

The command boots your application (honouring `src/main.ts` and registered providers), then drops into a prompt preloaded with useful globals: `app`, `auth`, discovered models, database helpers, and utilities from `@guren/testing`. Use `:help` to explore console shortcuts, or `:editor` when you need a multiline buffer.

### Typical workflow

1. **Launch** – `bunx guren console` from your project root.
2. **Execute code** – Issue ad-hoc queries or inspect services already registered during bootstrap scripts such as `src/main.ts`. Because the REPL shares scope across commands (and auto-registers models), you can run statements like `await Post.all()` directly without re-importing classes.
3. **Reset state** – Exit with `Ctrl+D` (or `.exit`) and relaunch the console when you need a clean slate.

### Tips

- Press `Ctrl+D` (or type `.exit`) to leave the REPL.
- `reloadModels()` refreshes the discovered model list if you add a new class while the console is running.
- `:load path/to/script.ts` executes the contents of a file inside the current session.
- Need the plain Bun REPL? Run `bun repl` for a minimal prompt or `bun repl --inspect` to pair with DevTools.

These patterns deliver the same iterative mode of operation you’d expect from a future `guren repl`, without waiting for a dedicated CLI wrapper.

## Application graph and runtime errors

| Command | Description | Example |
|---------|-------------|---------|
| `graph` | Print how the app is wired (routes, controllers, models, pages and the evidence linking them), read from the project on disk | `bunx guren graph --json` |
| `runtime:errors` | List the server errors the running development app hit recently (needs `GUREN_MCP=1`) | `bunx guren runtime:errors --json --url http://127.0.0.1:3333` |

[Application Graph and Runtime Errors](./application-diagnostics.md) covers both, the MCP tools that serve the same data to coding agents, and the Dev Center.

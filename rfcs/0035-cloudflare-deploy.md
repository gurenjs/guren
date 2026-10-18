# RFC: One-Command Cloudflare Deploy (`guren cloudflare:deploy`)

**Author:** Guren contributors
**Date:** 2026-10-18
**Status:** Draft

> Today a first Workers deploy of a Guren app takes five commands, and one of
> them needs a database ID pasted by hand. This RFC adds `guren cloudflare:deploy`.
> The command builds the app and works out which D1/KV/R2/Queues/cron bindings
> it needs. It then creates the missing ones, applies remote migrations behind
> the destructive migration guard, deploys, and prints the URL.
>
> Cloudflare's new `cf` CLI is the engine, and `cloudflare.config.ts` is the
> configuration. Wrangler stays behind it as the bundler `cf` delegates to,
> and as the backend for apps that have not migrated while Wrangler is still
> maintained. The RFC also looks at deploying through Void, and recommends
> against that for now.

## Problem

### The manual path

`@guren/plugin-cloudflare` (RFC 0003) produces a deployable directory, but
everything around it is manual. From `docs/ja/guides/cloudflare.md`, a first
deploy of an app with a database is:

```bash
bunx guren cloudflare:build                       # scaffolds wrangler.jsonc once
bunx wrangler d1 create my-app                    # prints an ID
# paste the ID into wrangler.jsonc → d1_databases[0].database_id
bunx guren cloudflare:build                       # regenerate .cloudflare/d1-migrations
bunx wrangler d1 migrations apply my-app --remote
bunx wrangler deploy
```

Each extra binding repeats the create-then-paste step by hand:
`wrangler r2 bucket create` plus an `r2_buckets` entry for storage,
`wrangler kv namespace create OAUTH_KV` for `--mcp-oauth`, and a hand-written
`triggers.crons` for scheduled tasks. The plugin chose to keep all of this
manual, and the source records why:

- `scaffoldWranglerConfig()` (`packages/plugin-cloudflare/src/build.ts`)
  writes `wrangler.jsonc` with `{ flag: 'wx' }` and never touches it again.
  On later builds it can only *warn* about build-owned keys that are missing
  (`warnMissingBuildOwnedKeys()`), and the developer pastes them in.
- The scaffold writes `database_id: 'TODO: wrangler d1 create'`, and with
  `--mcp-oauth` the `OAUTH_KV` id gets the same kind of placeholder. The
  placeholder also *switches off* the resource provisioning that Wrangler and
  `cf` already have, because a binding with an `id` counts as fully specified
  (Appendix B).
- No `r2_buckets` and no `triggers` are scaffolded. Cron in particular is left
  out on purpose: only a build that finds and loads the schedule kernel knows
  whether tasks exist, and the guide says the build stays silent rather than
  guess.
- The order of steps is easy to get wrong without any error. If
  `wrangler d1 migrations apply` runs before `cloudflare:build`, it finds the
  empty generated `migrations_dir`, says there is nothing to apply, and exits 0.
- Queues have no Workers path at all. On Workers the queue guide uses
  `RedisQueueDriver`. There is no Cloudflare Queues driver, and the generated
  worker has no `queue()` handler.

### The tooling underneath is changing

On 2026-09-28 Cloudflare released `cf`, an open-beta CLI generated from the
whole Cloudflare API, as Wrangler's successor
(<https://blog.cloudflare.com/cloudflare-cf-cli-launch/>). The plan it states:

- `cloudflare.config.ts`, a TypeScript file, is the new configuration format,
  "starting with Workers". `cf migrate` converts a Wrangler project to it.
- When the beta ends, a final major Wrangler release will point users to `cf`,
  and Wrangler gets 18 months of maintenance after that.
- For JavaScript Workers bundled with esbuild, which is how Guren's generated
  worker is bundled today, `cf` "will continue to delegate to Wrangler".

So anything Guren builds on `wrangler.jsonc` and Wrangler subcommands has a
known end date. That date is at least 18 months away and not yet fixed. Spike D
(Appendix C) ran `cf@1.0.0-beta.18` against a copy of `examples/agents`.

### The Lambda path is already provisioned

`@guren/plugin-lambda` ships `GurenLambdaApp`, a CDK construct
(`packages/plugin-lambda/src/cdk/index.ts`). One `cdk deploy` creates:

- the HTTP function and API;
- an SQS job queue with a dead-letter queue;
- an EventBridge schedule rule;
- a console function for `db:migrate`;
- an optional DynamoDB sessions table;
- an S3 + CloudFront assets distribution.

Every resource is declared as a prop, so the developer says what exists and
CDK makes it so. The Cloudflare path has no equivalent of that step.

### The competitor

Void (VoidZero, MIT, 1.0.3 and 1.1.11 both published 2026-10-15) does all of
this in one command. `void deploy`:

- builds the app;
- infers D1/KV/R2/AI/Queues bindings from imports such as `void/db` and from
  `env.X` accesses;
- creates the missing resources and records their IDs in `void.lock.json`;
- checks schema drift and applies migrations;
- uploads a staged version, checks readiness, and switches traffic.

Void depends on `cf` and `@cloudflare/config` itself.

Guren's selling point against it is that one app deploys to Workers, Vercel,
Lambda or a Bun server without lock-in. On Cloudflare, though, the
first-deploy experience is clearly worse.

### Goal

```bash
bunx guren cloudflare:deploy
```

On a clean checkout with `cf auth login` done (or `CLOUDFLARE_API_TOKEN`
set), this produces a running deployment and prints its URL. Run again with
no changes, it does nothing new and deploys the same code. Run in CI, it
never creates resources it was not told to create.

Not goals:

- Provisioning resources the app does not use. AI, Vectorize, Hyperdrive,
  Containers and email are left out.
- Named environments, which come in a later phase.
- Adding a Cloudflare API client to Guren. Every account operation goes
  through Cloudflare's CLI.

## Prior art (read 2026-10-18)

- **`cf` 1.0.0-beta.18** (Spike D, Appendix C).
  - **Provisioning.** `cf deploy` provisions an ID-less binding by default,
    with a documented `--provision` flag. It runs the same provisioning code
    as Wrangler: it inherits from the deployed Worker, connects to an
    existing resource by name, or creates a new one. It never writes IDs back
    (`skipProvisioningConfigWriteback: true`), and relies on inheritance
    afterwards.
  - **Config conversion.** `cf migrate` turns `wrangler.jsonc` into
    `cloudflare.config.ts` plus a `wrangler.config.ts` for the bundler
    options. It leaves `wrangler.jsonc` in place.
  - **D1 migrations.** `cf d1 migrations` can read drizzle's nested
    `<dir>/*/migration.sql` layout directly.
- **Wrangler 4.129–4.151** (Spike C, Appendix B). Wrangler has the same
  provisioning behind a hidden `--x-provision` flag that defaults to `true`.
  4.129 is the version in Guren's `bun.lock`.
- **Void 1.1.11** (Spike B, Appendix A). Void infers resources by scanning
  source, and records provisioned state in `void.lock.json` next to an
  authored `void.config.ts`.
- **`GurenLambdaApp`.** Resources are declared explicitly, and the IaC tool
  owns creation, update and deletion.

## Options

**A. Guren-owned orchestration on `cf`.** A `cloudflare:deploy` command in
the plugin:

- infers the binding set and supplies it to `cloudflare.config.ts` through a
  Guren helper;
- creates missing resources and applies guarded remote migrations, both
  through `cf`;
- runs `cf deploy`.

**B. Ride Void's deploy layer.** Have `cloudflare:build` emit something
`void deploy` accepts, and send users to Void.

**C. Lean on the CLI's own provisioning.** Stop writing placeholder IDs, so
that plain `wrangler deploy` or `cf deploy` creates the resources. Guren only
writes the bindings and runs the commands in order.

**Wrangler-only A.** The same orchestration on `wrangler.jsonc` and Wrangler
subcommands. This was this RFC's first draft (see Alternatives).

**Recommendation: A, with C as phase 0.**

- **Phase 0.** C alone, on today's Wrangler path. It is a scaffold change of
  a few lines that takes the first deploy from five commands to three, and
  it stays useful for as long as Wrangler is maintained.
- **Phases 1 to 3.** A, with `cf` as the engine. A thin backend layer keeps
  the stages runnable on Wrangler for apps that have not migrated.

Option B is not recommended at Void 1.1.11 (see the Option B section).

## Proposed Solution

### 1. The command

```
bunx guren cloudflare:deploy [--root <dir>] [--plan] [--yes] [--ci]
                             [--provision] [--skip-migrations]
                             [--allow-destructive] [--mcp-oauth] [--mcp-path <p>]
                             [--json]
```

It is registered in `gurenPlugin.commands.names` beside `cloudflare:build`
and `cloudflare:size`. It runs these stages in order and stops at the first
one that fails:

| # | Stage | What it does | Writes |
|---|-------|--------------|--------|
| 1 | Preflight | Picks the backend (§7). Checks the CLI version against the floor and checks that Node ≥ 22.18 is on `PATH` (§7). Checks the account: `cf auth list`, or `wrangler whoami --json` on the Wrangler backend. | nothing |
| 2 | Build | `buildCloudflareOutput()`, the same code `cloudflare:build` runs, into the backend's output directory (§3.3). | output dir |
| 3 | Plan | Evaluates the desired bindings (§2) and looks each named resource up in the account (§4). Lists the pending remote migrations (§6). Prints the plan. `--plan` stops here, with exit 1 on a blocker. | nothing |
| 4 | Provision | Creates each planned resource that does not exist yet (§4). | account |
| 5 | Secrets | Checks that every required server variable in `config/env.ts` is a Worker secret or var (§5). | nothing |
| 6 | Migrate | Judges the pending migrations with the RFC 0034 scanner, records a Time Travel bookmark, and applies them (§6). | D1 |
| 7 | Deploy | `cf deploy --prebuilt`, or `wrangler deploy` on the Wrangler backend. | Worker |
| 8 | Report | Prints the URL, what was created, migrated and deployed, and the rollback commands (§8). | nothing |

Without `--yes`, a TTY asks once, after stage 3, before anything is written.
The prompt shows the whole plan. `--yes`, `--ci` and a run with no TTY follow
§4's rules instead. `--json` prints one object:
`{ plan, created, migrated, deployment, url }`. It is the agent-facing form,
on the same convention as `guren check --json`.

`cloudflare:build` stays: it assembles output and nothing else. A developer
who wants to drive `cf` by hand keeps that path, and `cloudflare:deploy` is a
superset of it.

### 2. Which bindings an app needs

Void infers bindings from imports and `env.X` patterns. A Guren app does not
use either shape:

- bindings arrive through a closure, `binding: () => getWorkersEnv<Env>().DB`;
- the driver is picked at runtime, by
  `isWorkersRuntime() ? createD1Database(...) : createSqliteDatabase(...)`.

Spike B confirms the gap: `void info --json` reports no resources at all for
`examples/agents`. Guren can *ask the app* instead.

| Binding | Source of truth | Phase |
|---------|-----------------|-------|
| D1 `DB` | Already build-owned: the scaffold writes it, and `warnDatabaseWithoutD1()` exists. Once §2.1 lands, the introspected `database` section confirms it (`dialect: 'd1'`). | 1 |
| Durable Objects | `config/agents.ts`, already read by `readAgentRegistry()`. On `cf` they are declared as `exports: { Triager: exports.durableObject({ storage: 'sqlite' }) }`, because the Wrangler `migrations` list is not supported there (Spike D). | 1 |
| KV `OAUTH_KV` | `--mcp-oauth`, already build-owned in that mode. | 1 |
| Cron trigger | The schedule kernel, read the way `guren schedule:list` reads it. Any registered task gives one `* * * * *` trigger, since the worker runs whichever tasks are due at each firing. A kernel that cannot be read leaves triggers alone, which keeps today's rule against guessing. | 1 |
| R2 | Storage disks whose driver is `R2Driver`, from the introspected `storage` section, with the binding name taken from the driver's description (§2.1). | 2 |
| KV (app) | Any KV-backed driver that describes a binding name the same way. None ships today. The row is here so the rule exists before one does. | 2 |
| Queues | `config/queue.ts` with a Cloudflare Queues driver. That driver and the generated worker's `queue()` handler do not exist yet, so they are a prerequisite (§10, phase 3). | 3 |

Inference only ever **adds**. A binding the developer wrote is never edited
or removed. When inference and the developer disagree on a binding, the plan
reports a blocker and changes nothing. For example, the app has an R2 disk on
`MEDIA` but the config binds `MEDIA` to a KV namespace.

#### 2.1 Making Workers bindings visible to introspection

`guren introspect` runs `register()` under Bun, where `isWorkersRuntime()` is
false. The manifest therefore describes the *development* branch (`sqlite`,
`local` disks). Two additive changes fix this:

1. **A target override.** Under `GUREN_INTROSPECT=1` with
   `GUREN_INTROSPECT_TARGET=cloudflare`, `isWorkersRuntime()` returns true.
   Every Workers binding is already read lazily (RFC 0003, and
   `getWorkersEnv()` throws with that advice), so `register()` builds the D1
   factory and the R2 disk without an env existing.
2. **Bindings named as strings.** `createD1Database({ binding: 'DB' })` and
   `new R2Driver({ binding: 'MEDIA' })` accept the binding name, resolve it
   per request through `getWorkersEnv()`, and report it from `describe()`.
   The closure form keeps working. A closure is opaque, so for it the plan
   falls back to the build-owned `DB` and prints a hint.

### 3. Configuration: a Guren helper in `cloudflare.config.ts`

`cloudflare.config.ts` is TypeScript, and `defineConfig()` accepts a value, a
promise, or a function returning either. That makes rewriting the file
unnecessary. Guren exports the build-owned part as a function, and the
developer's config spreads it in:

```ts
// cloudflare.config.ts (scaffolded once, then the developer's)
import { bindings, defineConfig } from 'cf/config'
import { gurenWorker } from '@guren/plugin-cloudflare/config'

export default defineConfig(async () => {
  const worker = await gurenWorker({ name: 'my-app' })
  return {
    worker: {
      ...worker,
      env: { ...worker.env, MEDIA: bindings.r2({}) },
    },
  }
})
```

`gurenWorker()` is evaluated by `cf` on every build and deploy. It returns:

- `entrypoint`, `assets` and `compatibilityFlags`;
- the D1 binding (`bindings.d1({ name })`);
- `OAUTH_KV` under `--mcp-oauth`;
- the agent Durable Objects as `exports`;
- the cron trigger;
- from phase 2, the R2 and KV bindings §2 infers.

Spike D ran this shape with a stand-in helper that awaits, spreads a binding
set and an `exports` map, and is extended by the caller. `cf deploy --dry-run`
built it, and the emitted `worker.config.json` carried all of it.

Consequences:

- **Build-owned keys stop drifting.** The keys `warnMissingBuildOwnedKeys()`
  warns about today are computed, so an app scaffolded on an older plugin
  picks up a new one by upgrading the package. There is no text to edit and
  no comment-preserving JSONC writer to add.
- **The developer's additions stay theirs.** They live in the developer's own
  object literal, which Guren never reads or writes.
- **The plan reads the evaluated config, not the file.** `cf` writes the
  resolved configuration to `.cloudflare/output/v0/workers/default/worker.config.json`
  on build. Stage 3 compares that output with what §2 infers.

#### 3.1 Resource IDs are not stored in the repository

`cf` resolves an ID-less binding by name or by inheriting it from the deployed
Worker, and does not write IDs back. Guren follows that model. Every binding
the helper emits carries a deterministic name (§4) and no ID, and nothing
records IDs in the repository. Guren needs an ID only where a `cf` command
refuses a name. `cf d1 migrations apply` takes a database ID, so stage 3 looks
it up with `cf d1 list --name <name>` (JSON by default).

This differs from Void's `void.lock.json`, and from writing IDs back as
Wrangler 4.151 does interactively. It is the model the CLI itself chose, and
it means there is nothing to commit after a first deploy.

Whether `bindings.kv()` and `bindings.r2()` accept a name, as `bindings.d1()`
does, is unverified. Without one, a namespace or bucket is found by
inheritance only (Open Question 6).

#### 3.2 Bundling: `wrangler.config.ts`

Guren's worker still needs its esbuild `alias` and `define` entries: the
`bun:sqlite`, `vite` and `@guren/cli` stubs, `process.env.NODE_ENV`, and
`import.meta.url`. Under `cf` those move to `wrangler.config.ts`, which
imports `defineWranglerConfig` from `wrangler/experimental-config`.
`cf migrate` wrote exactly that for `examples/agents`. Guren exports
`gurenWranglerBundle()` for that file in the same way as `gurenWorker()`.

The import path says "experimental". This is the most fragile point of the
cf path, and the reason Open Question 3 asks whether Guren should move to the
Vite bundler instead (`cf migrate --bundler vite`, `@cloudflare/vite-plugin`).
Guren apps are already built with Vite.

#### 3.3 The output directory moves out of `.cloudflare/`

`cf` writes `.cloudflare/types/` and `.cloudflare/output/`.
`cloudflare:build` deletes and recreates `.cloudflare/` on every build
(`resetOutputDir()`), so it would delete `cf`'s files. `cf build` itself does
not touch the other files in `.cloudflare/` (Spike D). On the `cf` backend
the default output directory becomes `.guren/cloudflare/`. `outputDir` is
already an option, so this is a default per backend, not a new mechanism.
Apps on the Wrangler backend keep `.cloudflare/`.

### 4. Provisioning

Provisioning is its own stage, before upload:

| Resource | Lookup | Create |
|----------|--------|--------|
| D1 | `cf d1 list --name <name>` | `cf d1 create --name <name>` |
| KV | `cf kv namespaces list` | `cf kv namespaces create --title <name>` |
| R2 | `cf r2 buckets list` | `cf r2 buckets create --name <name>` |
| Queue | `cf queues list` | `cf queues create --queue-name <name>` |

On the Wrangler backend the same table maps to Appendix B's commands. There,
`r2 bucket list` and `queues list` print only text. `cf` prints JSON by
default.

`cf deploy` could create these resources itself, but the command creates
them first, for one reason. Migrations must run before the new code takes
traffic. Provisioning inside the deploy would put new code live against an
empty database. Creating first gives create → migrate → deploy. When
`cf deploy --provision` then runs, every binding already resolves by name,
so it creates nothing.

Rules:

- **Names are deterministic.** The D1 database is `<worker>`, the name
  `cloudflare:build` already scaffolds. The other resources are named
  `<worker>-<binding>` in lower case, which is the provisioning code's own
  default (`autoProvisionedResourceName()`). Plain `cf deploy` and
  `cloudflare:deploy` therefore agree.
- **Idempotent by lookup.** A resource found under the planned name is
  adopted, not created again. The plan prints "adopted" separately from
  "created", because adopting a resource that another project created under
  the same name is a real risk. A rerun after any failure converges: the
  account is the only state.
- **CI does not create by default.** Under `--ci`, or with no TTY and no
  `--yes`, a missing resource is a blocker unless `--provision` is passed.
  A first deploy from CI that silently creates databases is the failure
  Void's docs warn about.
- **Nothing is ever deleted.** When a later stage fails, the report lists
  what this run created and the delete commands. It does not run them, since
  a D1 database may already hold migrated tables.
- **No locking.** Two concurrent first deploys can both create. The docs say
  to run the first deploy from one machine.

### 5. Secrets

`config/env.ts` (RFC 0027) declares the required server variables. Stage 5
compares them with `cf workers secrets list` (on the Wrangler backend,
`wrangler secret list --format json`) plus the config's text bindings. If
any is missing, it refuses before upload and prints one command per name:
`cf workers secrets update <name>`.

It never reads `.env` or `.dev.vars`. A development value is not a production
value, and Void draws the same line.

### 6. Remote migrations and the destructive guard

RFC 0034 (destructive migration guard, Draft) adds `scanMigrationSql()`, the
`-- guren:allow-destructive` marker and `--allow-destructive`. For D1 it
assumes Guren never runs the apply, so its D1 guard is a `guren check` rule.
`cloudflare:deploy` runs the apply, so the guard becomes exact:

1. Stage 3 lists the pending migrations with
   `cf d1 migrations list <database-id> --dir db/migrations --pattern 'db/migrations/*/migration.sql'`,
   which prints JSON. `cf` reads drizzle 1.0's nested layout directly, so on
   the `cf` backend `flattenD1Migrations()` is no longer needed. Spike D
   applied `examples/agents`' three migrations from their folders this way.
2. Each pending file is judged with `scanMigrationSql()`. An unacknowledged
   finding refuses the deploy with exit 1, naming
   `<folder>/migration.sql:<line>`. `--allow-destructive` (or
   `GUREN_ALLOW_DESTRUCTIVE_MIGRATIONS=1`) applies anyway and still prints
   the findings, the same rules as `guren db:migrate`.
3. Before applying, the command records a Time Travel bookmark
   (`cf d1 time-travel get-bookmark <database-id>`) and prints it. On
   failure, the report includes the `cf d1 time-travel restore` command.
4. `cf d1 migrations apply <database-id>` with the same `--dir` and
   `--pattern`.

**The tracker names differ between layouts, which matters for existing
apps.**

- Wrangler applies the flattened copies and records `<folder>.sql` in
  `d1_migrations`.
- `cf` with the nested pattern records `<folder>/migration.sql`.

Point an existing app's database at the nested pattern, and every migration
it already applied looks pending. The apply would then run the whole history
again against a live database. The rule:

- **A new app** uses the nested pattern from the start.
- **An app that has ever applied migrations through Wrangler** keeps the
  flattened directory and the default `*.sql` pattern. The build keeps
  producing it on that app's output directory, and it is recorded in the
  helper's options (`gurenWorker({ d1MigrationLayout: 'flat' })`).
  `guren cloudflare:migrate` (§10, phase 2) writes that option. Switching an
  existing app needs a one-time rename of the tracker rows, and is Open
  Question 7.

Migrations run before the deploy. In between, and after any rollback, the old
code runs against the new schema. That is exactly the case the guard
protects: an additive migration is safe for the old code, and a destructive
one needed an acknowledgment. `--skip-migrations` leaves stage 6 out.

### 7. Backends and runtime requirements

The stages are written once, against a small backend interface with
operations such as `listD1`, `createD1`, `pendingMigrations`, `applyMigrations`,
`bookmark`, `listSecrets` and `deploy`. There are two implementations:

- **`cf`**, chosen when the app declares `cf` and has `cloudflare.config.ts`.
  New scaffolds get it. The floor is the first `cf` release this RFC is
  implemented against (1.0.0-beta.18 for Spike D). While `cf` is in beta, the
  argv contract is pinned per command by tests, the same way
  `wrangler-bundle.test.ts` pins the bundle.
- **`wrangler`**, chosen when only `wrangler.jsonc` exists. Existing apps
  keep working with nothing to change until they migrate. The floor is
  4.129.0, with Appendix B's verified commands. This backend is retired
  together with Wrangler's maintenance window.

`cf` needs Node.js: the package declares `node >= 22`, and loading
`cloudflare.config.ts` refuses to run on Bun ("cloudflare.config.ts loading
is not supported on Bun. Please use Node.js v22.18.0 or higher", Spike D).
Guren apps otherwise need Bun only, so the `cf` backend adds Node ≥ 22.18 to
the deploy machine. Preflight checks for it and names the requirement.
Wrangler's backend already needs Node for wrangler itself.

Guren never logs in for the developer. Preflight prints `bunx cf auth login`,
or `CLOUDFLARE_API_TOKEN` for CI.

### 8. Reporting the URL and rolling back

Stage 8 prints:

- the URL, the custom domains from the config's routes, and the version ID;
- the resources created and adopted;
- the migrations applied and the Time Travel bookmark;
- the rollback route (`cf workers deployments`, or `wrangler rollback` on
  that backend), with the warning that a rollback does not revert migrations.

### 9. Symmetry with Lambda

| Concern | Lambda (`GurenLambdaApp`) | Cloudflare (this RFC) |
|---------|---------------------------|-----------------------|
| Declaration | CDK props in the developer's stack | `cloudflare.config.ts`, with Guren's part spread in from `gurenWorker()` |
| Engine | `cdk deploy` (CloudFormation) | `cf` (Wrangler during the transition) |
| Job queue | `queue` prop → SQS + DLQ + worker function | Phase 3: Queues producer/consumer + DLQ queue |
| Schedule | `schedule` prop → EventBridge rule | Cron trigger from the schedule kernel |
| Migrations | `consoleFunction`, invoked by hand with `db:migrate` | Stage 6, guarded, before deploy |
| Sessions | `sessionsTable` → DynamoDB | `DatabaseSessionStore` on D1, nothing to provision |
| Assets | S3 + CloudFront | Workers Static Assets, nothing to provision |
| Deletion | CloudFormation removal policy | Never deletes, and lists what it created |

Under `cf` the two converge. Both are a typed configuration file, owned by
the developer, into which the framework's construct or helper contributes its
part.

### 10. Delivery

**Phase 0: stop blocking the CLI's own provisioning** (patch, Wrangler path)

- The scaffold omits `database_id`, and with `--mcp-oauth` omits the
  `OAUTH_KV` id, instead of writing `TODO:` placeholders. It keeps
  `database_name: <worker>`.
- A build that finds a `TODO:` ID warns and names the key to delete.
- The docs change the first deploy to `cloudflare:build` → `wrangler deploy`
  (which creates the database) → `wrangler d1 migrations apply --remote`.
  They say plainly that this leaves a window where code is live before its
  tables exist.
- Phase 0 relies on Wrangler's hidden `--x-provision` default. If Wrangler
  turns it off, an ID-less binding reaches the upload unresolved.
  `--dry-run` cannot show that failure (Appendix B, row 9).

**Phase 1: `cloudflare:deploy` on the `cf` backend** (minor)

- `@guren/plugin-cloudflare/config`, exporting `gurenWorker()` and
  `gurenWranglerBundle()`.
- Stages 1–8 for D1, agent Durable Objects (`exports`), `OAUTH_KV`, and cron.
- `.guren/cloudflare/` as the output directory, and the nested-pattern
  migrations.
- The guard needs RFC 0034's `scanMigrationSql()` to ship first.
- `guren new` / create-app scaffolds `cloudflare.config.ts` and
  `wrangler.config.ts` instead of `wrangler.jsonc`.
- The Wrangler backend for the same stages, for apps that have not migrated.
- Tests:
  - the plan as a pure function over the evaluated config;
  - the stages against fake `cf` and `wrangler` executables on `PATH` that
    record their argv;
  - one opt-in live test, skipped without `CLOUDFLARE_API_TOKEN`.

**Phase 2: migration and inference** (minor, plus additive `@guren/orm` and `@guren/cli` changes)

- `guren cloudflare:migrate` wraps `cf migrate` and resolves the follow-up
  work it leaves for a Guren app (Spike D):
  - the `migrations_dir` TODO is replaced by `d1MigrationLayout: 'flat'`;
  - the Wrangler DO `migrations` become `exports`;
  - the output directory moves;
  - the `throw` guard `cf migrate` writes is removed only once those are done.
- String binding names on `createD1Database` and `R2Driver`.
- `guren introspect --target cloudflare`.
- R2 and app KV inference, and the secrets check.

**Phase 3: Cloudflare Queues** (its own RFC)

- A Cloudflare Queues driver, a `queue()` handler in the generated worker,
  and a DLQ convention mirroring `GurenLambdaApp`'s.

**Later:**

- named environments;
- a staged rollout: `cf workers versions create`, a readiness probe, then
  `cf workers deployments create`. `versions create` has no `--provision`,
  which suits §4's explicit creation;
- the Vite bundler;
- revisiting Option B.

## Option B: deploying through Void

Spike B (Appendix A) ran `void@1.1.11` against a copy of `examples/agents`
and a minimal fixture shaped like `.cloudflare/worker.js`. Nothing was
deployed to any account. What it showed:

1. **Void owns the Worker entry.**
   - `vite build` with `voidPlugin()` writes `.void/entry.ts`, a generated
     `export default class extends WorkerEntrypoint` that dispatches into
     Void's own routing.
   - The deploy code overwrites `main` with Void's build output.
   - `inference.appType` accepts only `void`, `framework`, `spa` and
     `static`.
   - Void's own migration skill rewrites an existing Cloudflare app into
     `routes/` files.
2. **A Guren app can be carried only through a shim.**
   - A catch-all `routes/[...path].ts` forwarding to the Hono app served GET
     and POST and reached D1 under `wrangler dev`.
   - Every other entry point needs its own shim:
     - `scheduled` would move to `crons/`;
     - each agent Durable Object would need a `durable-objects/<name>.ts`
       wrapping it with `defineDurableObject()`, or it is dropped from the
       bundle;
     - the esbuild `alias` / `define` would have to become Vite settings.
   - `voidPlugin()` is required, so it would share a Vite config with
     Guren's `guren()` plugin and Inertia SSR build. That combination was not
     tried.
3. **Inference sees nothing in a Guren app.**
   - `void info --json` reported `resources: []`.
   - With `inference: { bindings: { db: true } }`, the build produced a `DB`
     binding named `default`.
4. **Migrations do not line up.**
   - `void db status` reported "No migration files found in db/migrations/"
     for Guren's drizzle 1.0 folder layout.
   - Void depends on `drizzle-orm ^0.45`. Next to Guren's `1.0.0-rc.4`,
     `void db generate` fails ("This version of drizzle-kit is outdated").
   - At runtime the two drizzle copies coexisted in a minimal select/insert.
5. **Void takes over the configuration.** `void migrate` moved
   `wrangler.jsonc` to `.void/config-migration/` and wrote `void.config.ts`
   and `void.lock.json`.
6. **The toolchain is heavier.**
   - `void` needs Node ≥ 24.21.
   - It pulls better-auth, pg, mysql2, better-sqlite3, miniflare, and its own
     drizzle-kit into the app.

Trade-offs:

| | A (Guren-owned, on `cf`) | B (Void) |
|---|---|---|
| Lock-in | None beyond Cloudflare. The output is a plain `cf` project, and every account operation is a `cf` command the developer can run. | Void becomes a second framework on top of Guren. `void.config.ts` and `void.lock.json` replace Cloudflare's own config. |
| Maintenance | A command, a config helper, and a two-backend layer in one plugin. The `cf` CLI is in beta and its commands are generated from the API, so the argv tests are what catch a change. | A shim generator against Void internals that changed weekly through 0.26 → 1.1.11. |
| Maturity | `cf` is a beta of Cloudflare's own successor CLI. Wrangler is stable and maintained for at least 18 months after `cf`'s beta ends. | Void 1.x was 3 days old at the time of writing, and framework mode does not cover a custom Hono app. |
| Relation to Cloudflare | Uses Cloudflare's CLI and configuration format directly, the same layer Void itself builds on (`cf`, `@cloudflare/config`). | VoidZero sits between Guren and the same `cf` layer. |
| Features | D1/KV/R2/Queues/cron/DO, guarded migrations, URL. No staged readiness check at first. | Staged upload + readiness + automatic rollback, ISR, email, AI, once the shim works. |

Revisit B when Void offers an app type that takes an existing Worker module
and its `exports` as they are, reads drizzle 1.0 migrations, and leaves
Cloudflare's own configuration in place. Appendix A's commands are the test.

## Alternatives Considered

**Wrangler-only orchestration (this RFC's first draft).** The same stages,
on `wrangler.jsonc` with a comment-preserving JSONC editor (`jsonc-parser`)
and Wrangler subcommands, with resource IDs written into `wrangler.jsonc`.
Every command in it was verified against 4.129 (Appendix B). It works today,
but it builds on the format and CLI that Cloudflare is winding down. It also
needs a text editor for configuration that `cloudflare.config.ts` makes
unnecessary. It survives as the Wrangler backend for apps that have not
migrated.

**Option C alone, with no new command.** Phase 0 already gets most of the
provisioning for free. It still leaves:

- three commands in the right order;
- no guard on remote migrations;
- code live before its schema on the first deploy;
- no cron or Durable Object handling;
- a dependency on Wrangler's hidden flag.

**Waiting for `cf` to leave beta before doing anything.** Phase 0 does not
depend on `cf`, and the backend interface keeps phase 1's stages independent
of either CLI. Waiting would leave the five-command path in place for an
unknown time.

**Terraform or Pulumi (Cloudflare provider).** Closest to the Lambda CDK
construct, but it means a second toolchain and a state backend for a handful
of bindings that `cf` already creates. An app using Terraform can run
`cloudflare:deploy --skip-migrations` with every resource present.

**Calling the Cloudflare REST API directly.** `cf` is generated from that API
and handles authentication. Calling it directly would mean reimplementing
`cf`.

## Migration Path

- **No change is required to keep working.** An app that keeps
  `cloudflare:build` + `wrangler deploy` sees only phase 0's warning on a
  `TODO:` ID. `cloudflare:deploy` picks the Wrangler backend for it.
- **Moving to `cf`** is `guren cloudflare:migrate` (phase 2). It runs
  `cf migrate --bundler wrangler` and then the Guren follow-ups:
  - replaces the generated binding and bundle entries with `gurenWorker()`
    and `gurenWranglerBundle()`;
  - converts the agent DO `migrations` to `exports`;
  - sets `d1MigrationLayout: 'flat'` for an app with remote migration
    history;
  - moves the output directory.

  It then runs `cloudflare:deploy --plan`, which should show nothing to
  create. Two things it cannot check locally go into Open Questions: whether
  a deployed DO class keeps its storage when its declaration moves from
  `migrations` to `exports` (5), and the tracker rename (7).
- **The closure form of `binding` keeps working.** The string form is what
  docs and new scaffolds teach from phase 2.

## Open Questions

1. **Staged rollout.** Should phase 1 deploy through
   `cf workers versions create` + a readiness probe +
   `cf workers deployments create` from the start?
2. **Adoption by name.** Is adopting an existing same-named resource the
   right default, or should it need `--adopt` outside a TTY?
3. **The bundler.** Should Guren stay on `wrangler.config.ts` from
   `wrangler/experimental-config`, or move its worker build to the Vite
   bundler `cf` prefers (`@cloudflare/vite-plugin`)? Guren already builds the
   app with Vite, so the second removes the esbuild alias stubs.
4. **Cron granularity.** One `* * * * *` trigger fires 1,440 times a day
   even when the finest task is hourly. Should the plan compute the coarsest
   trigger that still serves the finest task?
5. **Durable Object storage across the `migrations` → `exports` move.**
   `cf migrate` refuses Wrangler DO migrations and asks for `exports`. That a
   deployed `Triager` keeps its SQLite storage after the move needs a live
   account to confirm.
6. **Names for KV and R2 bindings.** `cf migrate` emitted `bindings.kv({})`
   and `bindings.r2({})` for ID-less entries. Can these carry a name, so that
   lookup by name works as it does for D1, or do they resolve by inheritance
   only?
7. **Renaming the D1 tracker rows.** Should `guren cloudflare:migrate` offer
   a guarded one-time `UPDATE d1_migrations` from `<folder>.sql` to
   `<folder>/migration.sql`? Or should existing apps stay on the flat layout
   for good?
8. **`cf` beta churn.** How long should the `cf` backend support each beta
   floor before raising it?

## Appendix A: Spike B — `void@1.1.11` (2026-10-18)

Everything ran in a throwaway directory outside the repository with Node
24.18.0 (`void` declares `engines.node >=24.21.0`: npm warned, and the CLI
ran). **Nothing was deployed and no Cloudflare login was made.** Only local
commands, local builds and `wrangler dev` ran.

| # | Command | Result | Verdict |
|---|---------|--------|---------|
| 1 | `npm pack void@1.1.11 @void/deploy-cloudflare@1.1.11 @void/deploy-core@1.1.11`, read `docs/` | `inference.appType`: `void` \| `framework` \| `spa` \| `static`. Framework mode covers TanStack Start, React Router, SvelteKit, Nuxt, Analog, Astro. The bundled `migrate-vite-cloudflare-to-void` skill rewrites an existing Worker into `routes/` files. | No mode for an arbitrary Worker entry |
| 2 | `npm install --ignore-scripts void@1.1.11 vite@8` | Installed with an `EBADENGINE` warning (Node 24.18 < 24.21). The `void` binary reports 1.1.11. | Runs, but needs a Node that Guren otherwise does not |
| 3 | `void info --json` in a copy of `examples/agents` | `{ "resources": [], "recordedResources": [] }` | D1 via `getWorkersEnv<Env>().DB` and the `Triager` DO not inferred |
| 4 | `void prepare` there | Wrote `.void/routes.d.ts`, `db.d.ts`, `tsconfig.json`. `RouteMap` was empty: Guren's `routes/web.ts` / `api.ts` (registrar functions, no `GET` exports) were ignored rather than misread. | No conflict, no use |
| 5 | `void migrate` there | Moved `wrangler.jsonc` to `.void/config-migration/` and wrote `void.config.ts` (`cloudflare: {…}` verbatim, comments dropped) + `void.lock.json` (`source`, `resolved`, original `text`). | Takes over the file Guren scaffolds and checks |
| 6 | `void db status` there | `No migration files found in db/migrations/` | drizzle 1.0 folder migrations not recognised |
| 7 | Fixture: Hono app shaped like `.cloudflare/worker.js` (`export default { fetch, scheduled }`, `export class Triager`, lazy `getWorkersEnv().DB`) + `routes/[...path].ts` and `routes/index.ts` forwarding `c.req.raw, c.env, c.executionCtx`; `vite build` with `voidPlugin()` | Built `dist/ssr/index.js` + `wrangler.json`, with `main: "index.js"` and `no_bundle: true`. `.void/entry.ts` is Void's generated `WorkerEntrypoint`. `Triager` appears in no output chunk. No D1 binding. | Void's entry replaces Guren's. DOs dropped. |
| 8 | Same, with `inference: { bindings: { db: true } }` | `d1_databases: [{ binding: "DB", database_name: "default", database_id: "local", migrations_dir: "../../migrations" }]` | Override works, with Void's naming |
| 9 | `wrangler dev -c dist/ssr/wrangler.json`; `curl GET /`, `POST /posts`, `GET /db` | `200 guren home`; `201 {"created":"hello"}`; D1 `select 1` → `[{"one":1}]` | HTTP and D1 cross the shim |
| 10 | Read `@void/deploy-cloudflare` and `void/dist` | `upsert(["main"], options.main)` when writing the deploy config. The generated entry exports only DOs discovered in `durable-objects/` (`defineDurableState` / `defineDurableObject`). | Confirms 7 for deploy, not only build |
| 11 | New fixture: `npm install void@1.1.11 vite@8 hono drizzle-orm@1.0.0-rc.4` | App `drizzle-orm` 1.0.0-rc.4, `void/node_modules/drizzle-orm` 0.45.4 | Two drizzle majors installed |
| 12 | `db/schema.ts` with a drizzle 1.0 `sqliteTable('posts')`; `void db generate` | `This version of drizzle-kit is outdated` … `Migration generation failed; previous SQL, snapshots and journal were restored.` | Void's migration tooling refuses a drizzle 1.0 app |
| 13 | `routes/guren.ts` inserting and selecting through `drizzle-orm/d1` (1.0) on `c.env.DB`; `routes/void.ts` selecting through `void/db` from `@schema`; `vite build` + `wrangler dev` | Both `GET /guren` and `GET /void` return `200` with the same rows | Runtime coexistence holds for a plain select/insert. Types not checked |

Not tried: the real `.cloudflare/worker.js` of `examples/agents` through the
shim (its `alias`/`define` would need Vite equivalents), `voidPlugin()` beside
Guren's `guren()` Vite plugin and Inertia SSR build, and `void deploy`
itself (it needs a Cloudflare login and creates resources).

## Appendix B: Spike C — wrangler's resource provisioning (2026-10-18)

Wrangler is the backend for apps not yet on `cf`, and the bundler `cf` delegates to. Rows 7–8 verify the commands that backend runs.

| # | Command | Result |
|---|---------|--------|
| 1 | Read `wrangler-dist/cli.js` of 4.151.0 and 4.129.0 | Both: hidden `experimental-provision` (alias `x-provision`, default `true`) and `experimental-auto-create` (alias `x-auto-create`, default `true`). `provisionBindings()` runs in both `deployWorker()` and `uploadWorkerVersion()`. Provisionable types: `kv_namespace`, `d1`, `r2_bucket`, `queue` (plus AI Search, agent memory, dispatch namespaces, Flagship). A binding without an ID inherits from the deployed Worker's settings, connects to an existing resource, or is created. The default name is `${scriptName}-${binding.toLowerCase().replaceAll("_", "-")}`. |
| 2 | Same | 4.151.0 adds `writeProvisionedIdsToConfig()`, skipped when `isNonInteractiveOrCI()`. In CI the IDs are not written back ("future deploys will continue to work even without IDs" via inheritance). 4.129.0 has no write-back. |
| 3 | `wrangler@4.151.0 deploy --dry-run` and `wrangler@4.129.0 deploy --dry-run` with `d1_databases: [{ binding: "DB", database_name: "…" }]`, `kv_namespaces: [{ binding: "CACHE" }]`, `r2_buckets: [{ binding: "MEDIA" }]`, a queue producer and a cron, all without IDs | Both validate and list the four bindings, then stop at `--dry-run: exiting now.` |
| 4 | Read the handler base class | `shouldProvision()` returns false when the binding `isFullySpecified()`. A placeholder such as `database_id: "TODO: wrangler d1 create"` counts as specified, so today's scaffold opts out of provisioning (phase 0). |
| 5 | `wrangler@4.151.0 dev` on the same config; `curl /` | The D1 query is served by the local miniflare database. A missing `database_id` does not break local development. |
| 6 | `wrangler@4.151.0 d1 migrations apply DB --local` | `0001_init.sql ✅`. Both versions contain the "Couldn't find an auto-provisioned D1 DB named …" lookup that `--remote` uses to resolve an ID-less binding by name. |
| 7 | `wrangler@4.129.0 <cmd> --help` for the commands §1, §4, §5, §6 name | `whoami --json`, `d1 list --json`, `d1 time-travel info --json`, `secret list --format json` and `d1 execute --json` exist. `kv namespace list` prints JSON with no flag. `r2 bucket list`, `queues list` (paginated) and `d1 migrations list` have no JSON output. `d1 create`, `kv namespace create` and `r2 bucket create` take `--binding` and `--update-config`. |
| 8 | `wrangler@4.129.0 d1 execute DB --local --json --command "select name from d1_migrations"` | `[{ "results": [{ "name": "0001_init.sql" }], "success": true, … }]`, the tracker the Wrangler backend reads (it has no JSON `migrations list`) |
| 9 | `wrangler@4.151.0 deploy --dry-run --x-provision=false` on the ID-less config | Still lists the bindings and exits at `--dry-run`. A dry run cannot show whether an unprovisioned upload fails |

## Appendix C: Spike D: `cf@1.0.0-beta.18` (2026-10-18)

All runs were local, with Node 24.18.0, in throwaway directories outside the
repository. **There was no login and nothing was deployed.** Source of the
plan: <https://blog.cloudflare.com/cloudflare-cf-cli-launch/> (2026-09-28).

| # | Command | Result | Verdict |
|---|---------|--------|---------|
| 1 | `npm view cf time`; `npm view wrangler deprecated` | `cf` 1.0.0-beta.18 published 2026-10-16. Wrangler carries no npm deprecation. | `cf` is a beta, and Wrangler is still current |
| 2 | `cf deploy --help` | Has `--provision` ("Automatically provision resources for bindings that need them", default `true`), `--prebuilt`, `--dry-run` | Provisioning is a documented flag |
| 3 | Read `cf/dist/deploy-input-*.mjs` | `resourcesProvision: provision ?? true`, `skipProvisioningConfigWriteback: true`, uploads with `bindings_inherit: strict`. The provisioning functions are Wrangler's (`writeProvisionedIdsToConfig`, `trackSkippedProvisioning`). | IDs are not written back. Resolution is by name or inheritance |
| 4 | `cf migrate --dry-run --no-install` in a copy of `examples/agents` (a git repository) | `Using the Wrangler bundler because @cloudflare/vite-plugin is not declared`. Would write `cloudflare.config.ts` and `wrangler.config.ts`. Required follow-ups: `migrations_dir` "require manual migration"; Durable Object bindings need review; "Wrangler Durable Object migrations are unsupported. Replace them with an exports lifecycle declaration". | Guren's D1 migrations dir and DO migrations do not convert by themselves |
| 5 | `cf migrate --no-install` there | `cloudflare.config.ts` gets `entrypoint: ".cloudflare/worker.js"`, `bindings.d1({ name, id })`, `bindings.durableObject({ exportName: "Triager" })`, TODO comments, and a top-level `throw new Error("Migration incomplete…")`. `wrangler.config.ts` (`wrangler/experimental-config`) gets the `alias`, `define` and assets directory. `wrangler.jsonc` stays. | Bundler options move to an experimental Wrangler API |
| 6 | `cf migrate` on an ID-less probe config (D1 with a name, KV, R2, a queue, a cron) | `bindings.d1({ name })`, `bindings.kv({})`, `bindings.r2({})`, `bindings.queue({ name })`, `triggers.scheduled({ schedule: "* * * * *" })` | ID-less bindings are the native shape |
| 7 | `cf build` with no `wrangler` in `package.json` | "No Cloudflare dev-server is installed in this project", listing `@cloudflare/vite-plugin` (recommended) and `wrangler` ("legacy Worker projects") | The app must declare one |
| 8 | `cf build` and `cf deploy --dry-run` with `wrangler` declared | `Delegating to Wrangler`, `Build complete`. Writes `.cloudflare/types/index.d.ts` and `.cloudflare/output/v0/`. The dry run lists the four bindings. | Works, and the esbuild path delegates to Wrangler |
| 9 | Files placed in `.cloudflare/guren/` and `.cloudflare/stub-x.js` before `cf build` | Both still present afterwards | `cf` does not wipe `.cloudflare/`. `cloudflare:build`'s `resetOutputDir()` would wipe `cf`'s files (§3.3) |
| 10 | `bun node_modules/cf/bin/cf build` with no Node on `PATH` | `--version` works. The build fails: "cloudflare.config.ts loading is not supported on Bun. Please use Node.js v22.18.0 or higher." | The `cf` backend needs Node ≥ 22.18 |
| 11 | `cloudflare.config.ts` as `defineConfig(async () => …)` spreading an awaited helper's `env` and `exports: { Triager: exports.durableObject({ storage: 'sqlite' }) }`; `cf deploy --dry-run` | Built. `worker.config.json` holds `"env": {"DB": {"type": "d1", "name": …}, "MEDIA": {"type": "r2"}}` and `"exports": {"Triager": {"type": "durable-object", "storage": "sqlite"}}` | The §3 helper shape works. `defineConfig` accepts `T \| Promise<T> \| (ctx) => …` per `@cloudflare/config`'s types |
| 12 | `cf d1 migrations apply --help` | Takes a database **ID** ("Database names and binding names are not accepted"). Has `--dir`, `--pattern` ("Drizzle's nested layout uses `<dir>/*/migration.sql`") and `--table` (default `d1_migrations`). | Guren looks up the ID. The nested layout is supported |
| 13 | `cf d1 migrations list/apply <id> --local --dir gm --pattern 'gm/*/migration.sql'` on a copy of `examples/agents/db/migrations` | `list` prints JSON with the three `<folder>/migration.sql` names. `apply` applies all three (`✅`). | No flattening needed. The tracker names differ from Wrangler's `<folder>.sql` (§6) |
| 14 | `--help` of `cf d1 list`, `d1 create`, `d1 time-travel`, `kv namespaces create`, `r2 buckets create`, `queues create`, `workers secrets`, `workers versions create`, `workers deployments` | Present as §4–§8 name them: `d1 list --name`, `d1 create --name`, `time-travel get-bookmark/restore <id>`, `kv namespaces create --title`, `r2 buckets create --name`, `queues create --queue-name`, `workers secrets list/update`. `workers versions create` has `--prebuilt` and no `--provision`. | Command names verified |

Not tried: a real `cf deploy` (it needs an account), and `cf` against a real
Guren build of `.cloudflare/worker.js` (the probe worker stood in for it). The
`cf` help output opens with instructions addressed to coding agents. Those
were treated as tool output, not followed.

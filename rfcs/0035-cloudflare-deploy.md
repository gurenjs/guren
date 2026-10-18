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
known end date. That date is at least 18 months away and not yet fixed.

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
                             [--allow-destructive] [--secrets-file <path>]
                             [--json]
```

It is registered in `gurenPlugin.commands.names` beside `cloudflare:build`
and `cloudflare:size`. It runs these stages in order and stops at the first
one that fails. Every operation on the account or the CLI goes through the
backend interface (§7).

| # | Stage | What it does | Writes |
|---|-------|--------------|--------|
| 1 | Preflight | Picks the backend from which config file exists (§7), then probes only that backend's tools and the account, concurrently. | nothing |
| 2 | Assemble | `buildCloudflareOutput()` into the backend's output directory (§3.3), sharing one introspection of the app (§2). Writes the build manifest `gurenWorker()` reads, carrying over the previous run's `resolved` section (§3). | output dir |
| 3 | Plan | Evaluates the configuration and resolves every binding (§3.1). Reads the pending migrations (§6). Runs the plan checks (§1.1) and prints the plan. Everything here only reads, so a run that is going to fail does so before it creates anything. `--plan` stops here, with exit 1 on a blocker. | nothing |
| 4 | Provision | Creates each planned resource that does not exist yet (§4), and writes the new resolution into the manifest. Skipped when nothing is missing and the resolution did not change. | account, manifest |
| 5 | Build | Rebuilds, so that `gurenWorker()` emits the new resolution, and checks the result against it. Skipped when stage 4 changed nothing, because stage 3's build already carries the same IDs. | output dir |
| 6 | Migrate | Judges the pending migrations with the RFC 0034 scanner, records a Time Travel bookmark, lists the pending set again, and applies it only if it is unchanged (§6). Skipped when nothing is pending. | D1 |
| 7 | Deploy | Deploys the build from stage 3 or 5 with provisioning off. A binding that no longer resolves fails the deploy instead of being created (§4). | Worker |
| 8 | Report | Prints the URL, what was created, migrated and deployed, and the rollback route (§8). | nothing |

On a rerun with no changes, the command builds once, creates nothing,
applies nothing, and deploys the same code.

Without `--yes`, a TTY asks once, after stage 3, before anything is written.
`--json` prints one object, `{ plan, created, migrated, deployment, url }`,
on the same convention as `guren check --json`. `cloudflare:build` stays: it
assembles output and nothing else.

#### 1.1 Plan checks

Stage 3 runs one list of checks over a single context: the evaluated config,
the manifest, the account listings and the tracker rows. Each check returns
findings with a severity and a fix. `--plan`, `--json`, the TTY prompt and
`--ci` all read that one list.

| Check | Blocks when | Section |
|-------|-------------|---------|
| `binding-conflict` | Two sources name different resources for one binding | §3.1 |
| `resource-missing` | A resource does not exist and the run may not create it | §4 |
| `resource-name` | A planned name breaks a Cloudflare name limit | §4 |
| `oauth-drift` | The deployed Worker binds `OAUTH_KV` but `config/cloudflare.ts` turns OAuth off | §3 |
| `cron-coverage` | A developer-declared trigger fires less often than the finest task needs | §2 |
| `tracker-layout` | The tracker holds both flattened and nested names | §6 |
| `secrets` | A required secret is neither set nor in `--secrets-file` | §5 |
| `serialization` | Warning only: running in GitHub Actions without the per-Worker concurrency group | §4 |

A new check is one more entry, which is also how Open Question 4 would land.

### 2. Which bindings an app needs

Void infers bindings from imports and `env.X` patterns. A Guren app uses
neither:

- bindings arrive through a closure, `binding: () => getWorkersEnv<Env>().DB`;
- the driver is picked at runtime, by
  `isWorkersRuntime() ? createD1Database(...) : createSqliteDatabase(...)`.

Spike B confirms the gap: `void info --json` reports no resources for
`examples/agents`. Guren can ask the app instead.

| Binding | Source of truth | Phase |
|---------|-----------------|-------|
| D1 `DB` | Already build-owned: the scaffold writes it, and `warnDatabaseWithoutD1()` exists. Once §2.1 lands, the introspected `database` section confirms it (`dialect: 'd1'`). | 1 |
| Durable Objects | `config/agents.ts`, already read by `readAgentRegistry()`. On `cf` they are declared as `exports: { Triager: exports.durableObject({ storage: 'sqlite' }) }`, because the Wrangler `migrations` list is not supported there (Spike D). | 1 |
| KV `OAUTH_KV` | `mcpOAuth` in `config/cloudflare.ts` (§3). | 1 |
| Cron trigger | One task set: the schedule kernel's tasks, plus the OAuth storage sweep when `mcpOAuth` is on. The sweep runs from `scheduled` (`renderDefaultExport()`). A non-empty set gives one `* * * * *` trigger, since the worker runs whichever tasks are due at each firing. A kernel that cannot be read leaves triggers alone, which keeps today's rule against guessing. | 1 |
| R2 | Storage disks whose driver is `R2Driver`, from the introspected `storage` section, with the binding name from the driver's description (§2.1). | 2 |
| KV (app) | Any KV-backed driver that describes a binding name the same way. None ships today. The row is here so the rule exists before one does. | 2 |
| Queues | `config/queue.ts` with a Cloudflare Queues driver. That driver and the generated worker's `queue()` handler do not exist yet, so they are a prerequisite (§10, phase 3). | 3 |

The kernel is read with `loadScheduleKernel()` from `packages/cli/src/schedule.ts`.
That function is exported for this purpose, so `schedule:list` and the plan
share one reader and one "unreadable" rule.

Some inference results are treated specially:

- **A trigger the developer declares wins.** When `triggers` appears in
  `cloudflare.config.ts`, it replaces the helper's, because the developer's
  key comes later in the spread. The `cron-coverage` check then judges it.
- **A sweep-only app keeps today's behaviour.** `handler.scheduled` throws
  after the sweep when no `scheduler` is bound, and the plan reports that.
- **Inference only adds.** It is one more source in §3.1's resolution, so a
  binding the developer wrote is never edited, and any disagreement is a
  `binding-conflict`.

#### 2.1 One introspection, with Workers bindings visible

`guren introspect` runs `register()` under Bun, where `isWorkersRuntime()` is
false, so the manifest describes the development branch (`sqlite`, `local`
disks). Two additive changes fix this:

1. **A target override.** `isWorkersRuntime()` (`packages/plugin-cloudflare/src/env.ts`)
   returns true under `GUREN_INTROSPECT=1` with
   `GUREN_INTROSPECT_TARGET=cloudflare`. The deploy passes the variable
   through `introspectApp(cwd, { env })`, the channel `browser:serve`
   already uses for `DATABASE_URL`. So no new CLI flag is needed. Every
   Workers binding is already read lazily (RFC 0003), so `register()` builds
   the D1 factory and the R2 disk without an env existing.
2. **Bindings named as strings.** `createD1Database({ binding: 'DB' })` and
   `new R2Driver({ binding: 'MEDIA' })` accept the binding name, resolve it
   per request through `getWorkersEnv()`, and report it from `describe()`.
   The closure form keeps working. A closure is opaque, so for it the plan
   falls back to the build-owned `DB` and prints a hint.

The deploy runs this introspection once. Its result feeds inference and the
agent registry. It also feeds `reportDeployRuntimeHazards()`, which
`buildCloudflareOutput()` would otherwise run in a child of its own.

### 3. Configuration

Three files are authored, and one is generated:

| File | Who writes it | Holds |
|------|---------------|-------|
| `cloudflare.config.ts` | Scaffolded once, then the developer's | The Worker, with Guren's part spread in from `gurenWorker()` |
| `wrangler.config.ts` | Scaffolded once | The esbuild options from `gurenWranglerBundle()` (§3.2) |
| `config/cloudflare.ts` | The developer | Guren's deploy settings: `defineCloudflareConfig({ mcpOAuth, resourceNames })` |
| `<out>/guren-worker.json` | `cloudflare:build`, every run | The build manifest, including `resolved` |

`cloudflare.config.ts` is TypeScript, and `defineConfig()` accepts a value, a
promise, or a function returning either. That makes rewriting the file
unnecessary:

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

**`config/cloudflare.ts`** is a build-time definition. The deploy and the build
read it, and the app never does at runtime. So it is not wired through
`createApp({ config })`, and the `config-unwired` check of RFC 0027 skips it
by name. It replaces the `--mcp-oauth` build flag, which today is recorded
nowhere: forgetting it once ships a worker without the OAuth provider, and
`/oauth/token` then answers 404. `cloudflare:build --mcp-oauth` is
deprecated on the `cf` backend. The `oauth-drift` check turns today's
`warnOAuthDrift()` warning into a blocker when the deployed Worker still
binds `OAUTH_KV`.

**`gurenWorker()`** runs inside `cf`, under Node, in a different process from
the Bun build that knows the app. So it computes nothing about the app. It
reads the manifest, and its options are `{ name, outputDir? }` (§3.3 gives
the default). A missing or unreadable manifest is an error that names
`bunx guren cloudflare:build`.

The manifest is plain JSON and is rebuilt from the app on every run. It holds:

- the entrypoint, assets directory and compatibility flags;
- the D1 binding and database name;
- the `mcpOAuth` setting;
- the agent classes;
- the cron task set;
- from phase 2, the bindings §2 infers;
- **`resolved`**: one resource identity per binding, written by stage 4 and
  carried over to the next run (§3.1).

The helper returns all of that in `cf` form. A binding with an entry in
`resolved` gets that identity. A binding without one is emitted in whatever
form its type accepts without an ID:

- D1, R2 and Queues by their deterministic name (§4);
- KV with neither name nor ID, because `bindings.kv()` takes only an ID.

So a plain `cf build` or `cf deploy` without Guren still works. `cf` resolves
those bindings itself, by inheritance or by its own default name, which is
the same `<worker>-<binding>` rule.

Spike D ran this shape with a stand-in helper that awaits, spreads a binding
set and an `exports` map, and is extended by the caller. `cf deploy --dry-run`
built it, and the emitted `worker.config.json` carried all of it. The
stand-in hard-coded its values, so the manifest handoff is not yet exercised.

Consequences:

- **Build-owned keys stop drifting.** The keys `warnMissingBuildOwnedKeys()`
  warns about today are computed, so an app scaffolded on an older plugin
  picks up a new one by upgrading the package.
- **The developer's additions stay theirs.** They live in their own object
  literal, which Guren never reads or writes.
- **The plan reads the evaluated config.** That is `cf`'s
  `.cloudflare/output/v0/workers/default/worker.config.json`, not the source
  file.

#### 3.1 Resolving each binding once

Left to the deploy, `cf`'s resolution (Prior art) can disagree with Guren's.
Suppose the deployed Worker's `DB` points at a database other than the one
named `<worker>`. Then stage 6 would migrate one database while the deploy
binds another. So stage 3 resolves every binding once, and that answer is the
only one.

The sources:

| Source | How it is read |
|--------|----------------|
| An ID the developer wrote | `worker.config.json`, minus the IDs the helper emitted from `resolved` |
| The deployed Worker's binding | `cf workers deployments list` names the active version, and `cf workers versions get` returns it (the response shape needs an account to confirm, Open Question 9) |
| The resource with the deterministic name | The listings in §4 |
| Inference | §2 |

If the sources agree, the binding resolves to that resource. If any two name
different resources, that is a `binding-conflict`, and the plan names all of
them. If none exists, the plan creates the resource, or reports
`resource-missing` under `--ci`.

The carried-over `resolved` section is never trusted, only compared. If the
fresh resolution equals it, stage 3's build is already the deploy build, and
stages 4 and 5 are skipped. If it differs, stage 4 writes the new one and
stage 5 rebuilds. Stage 5 then checks that every binding in the new
`worker.config.json` names exactly the resolved resource.

The binding types decide what has to be carried:

- `bindings.d1()` accepts `{ id, name }`, and `bindings.r2()` accepts
  `{ name }`.
- `bindings.kv()` accepts only `{ id }` (Spike D row 15).
- For D1 the ID is what stage 6 needs, since `cf d1 migrations apply`
  refuses names.

No ID enters the repository. The build writes a `.gitignore` of `*` into the
output directory after emptying it, the way `runsDirectory()` in
`packages/cli/src/browser-record.ts` does. That covers `.guren/cloudflare/`,
which the default template does not ignore (it ignores only `.guren/ssr/`).
This differs from Void's `void.lock.json`, and from Wrangler 4.151 writing IDs
back interactively.

#### 3.2 Bundling: `wrangler.config.ts`

Guren's worker still needs its esbuild `alias` and `define` entries: the
`bun:sqlite`, `vite` and `@guren/cli` stubs, `process.env.NODE_ENV`, and
`import.meta.url`. Under `cf` those move to `wrangler.config.ts`, which
imports `defineWranglerConfig` from `wrangler/experimental-config`.
`cf migrate` wrote exactly that for `examples/agents`, and
`gurenWranglerBundle()` supplies the values.

The import path says "experimental". This is the most fragile point of the
`cf` path, and the reason for Open Question 3 (the Vite bundler).

#### 3.3 The output directory moves out of `.cloudflare/`

`cf` writes `.cloudflare/types/` and `.cloudflare/output/`.
`cloudflare:build` deletes and recreates `.cloudflare/` on every build
(`resetOutputDir()`), so it would delete `cf`'s files. `cf build` does not
touch other files there (Spike D row 9). On the `cf` backend the default
output directory is therefore `.guren/cloudflare/`. `outputDir` is already
an option, so this is a per-backend default, not a new mechanism. Apps on
the Wrangler backend keep `.cloudflare/`.

### 4. Provisioning

| Resource | Listing | Create |
|----------|---------|--------|
| D1 | `cf d1 list` | `cf d1 create --name <name>` |
| KV | `cf kv namespaces list` | `cf kv namespaces create --title <name>` |
| R2 | `cf r2 buckets list` | `cf r2 buckets create --name <name>` |
| Queue | `cf queues list` | `cf queues create --queue-name <name>` |

On the Wrangler backend the same table maps to Appendix B's commands. Stage 3
issues one listing per resource type, concurrently with the deployed-version
lookup, the secrets listing and the tracker read, and resolves every binding
from those results in memory. The `d1 list` result also supplies the
database ID that the migration commands need.

`cf deploy` could create these resources itself, but the command creates
them first, for two reasons:

- **Migrations must run before the new code takes traffic.** Provisioning
  inside the deploy would put new code live against an empty database.
- **The deploy must not resolve on its own (§3.1).** Stage 7 runs
  `cf deploy --no-provision` (Wrangler: `--x-provision=false`). A resource
  deleted after the plan therefore fails the deploy instead of being created
  unplanned. Beta.18 accepts `--no-provision` (Spike D row 16). Whether it
  fails cleanly on an unresolved binding needs an account to confirm.

Rules:

- **Names are deterministic.** The D1 database is `<worker>`, the name
  `cloudflare:build` already scaffolds. Every other resource is
  `<worker>-<binding>`, lowercased with each `_` replaced by `-`: `OAUTH_KV`
  on `my-app` becomes the KV namespace titled `my-app-oauth-kv`. This is the
  provisioning code's own `autoProvisionedResourceName()` (Appendix B row 1),
  so a plain `cf deploy` picks the same names. One function holds the rule,
  shared by the plan, the helper and the tests.
- **Names are checked before anything is created.** A long Worker name plus
  a long binding can exceed Cloudflare's limits, for example R2 bucket names
  of 3–63 lowercase letters, digits and hyphens. That is a `resource-name`
  blocker, not a stage 4 error after other resources exist. The fix is an
  explicit name in `config/cloudflare.ts` (`resourceNames`).
- **Idempotent by lookup.** A resource found under the planned name is
  adopted, not created again. The plan prints "adopted" separately from
  "created", because adopting a resource that another project created under
  the same name is a real risk.
- **CI does not create by default.** Under `--ci`, or with no TTY and no
  `--yes`, a missing resource is `resource-missing` unless `--provision` is
  passed.
- **Nothing is ever deleted.** When a later stage fails, the report lists
  what this run created and the delete commands. It does not run them, since
  a D1 database may already hold migrated tables.
- **Deploys of one Worker are serialized outside Guren.** Two concurrent
  runs can create the same resource, apply the same migrations, or deploy
  over each other. Guren has no lock of its own, since that would need state
  outside the account. Serialization is a stated requirement instead:
  - `guren deploy --target cloudflare` adds a GitHub Actions workflow to the
    existing per-target scaffolds of `scaffoldDeploy()`
    (`packages/cli/src/deploy.ts`). It runs the command under
    `concurrency: { group: cloudflare-deploy-<worker>, cancel-in-progress: false }`;
  - the `serialization` check warns when that group is missing.

  Inside one run, stage 6 narrows the window by listing the pending set
  again right before applying.

### 5. Secrets

The required server variables come from `loadEnvSchema()`
(`packages/cli/src/app-env.ts`), the reader the CLI already uses for
`config/env.ts`. The `secrets` check compares them with the backend's secret
listing (`cf workers secrets list`, or `wrangler secret list --format json`)
plus the config's text bindings.

On a first deploy there is no Worker to set a secret on. So the check also
accepts a name that appears in `--secrets-file <path>`, a file forwarded to
`cf deploy`'s own `--secrets-file` (Spike D row 2). The names in that file
are read with `envFileKeys()` (`packages/cli/src/plugin-manifest.ts`), and
the values are never read. On later deploys the check prints one
`cf workers secrets update <name>` per missing name. The command never reads
`.env` or `.dev.vars`: a development value is not a production value, and
Void draws the same line.

### 6. Remote migrations and the destructive guard

RFC 0034 (destructive migration guard, Draft) adds `scanMigrationSql()`, the
`-- guren:allow-destructive` marker and `--allow-destructive`. For D1 it
assumes Guren never runs the apply, so its D1 guard is a `guren check` rule.
`cloudflare:deploy` does run the apply, so the guard becomes exact.

**The layout is read from the tracker.** Wrangler applies flattened copies
and records `<folder>.sql` in `d1_migrations`. `cf` can read drizzle 1.0's
nested layout directly (`--pattern '<dir>/*/migration.sql'`, Spike D
row 13), and records `<folder>/migration.sql`. Pointing an existing database
at the other layout would make its whole history look pending, and the apply
would run it again against live data. So the build keeps emitting the
flattened copy (`flattenD1Migrations()`), and stage 3 picks the layout per
database from what the tracker already holds:

| Tracker rows | Layout | `cf d1 migrations` arguments |
|--------------|--------|------------------------------|
| None, or no tracker table | nested | `--dir db/migrations --pattern 'db/migrations/*/migration.sql'` |
| `<folder>/migration.sql` only | nested | the same |
| `<folder>.sql` only | flat | `--dir <out>/d1-migrations` |
| Both | none | `tracker-layout` blocker |

An app moved from Wrangler thus stays flat without any setting. Renaming its
rows to switch layout is optional (Open Question 7). The Wrangler backend is
always flat.

The steps:

1. **Read the tracker.** On a first deploy the database does not exist yet,
   so every local migration is pending, and the ID comes from stage 4. The
   `cf` backend lists the pending set with `cf d1 migrations list
   <database-id>` and the layout's arguments, which prints JSON. The
   Wrangler backend runs one `d1 execute --json` query on `d1_migrations`
   (Appendix B row 8). A "no such table" error there means nothing has been
   applied.
2. **Judge.** Each pending file is judged with `scanMigrationSql()`. An
   unacknowledged finding refuses the deploy with exit 1, naming
   `<folder>/migration.sql:<line>`. `--allow-destructive` (or
   `GUREN_ALLOW_DESTRUCTIVE_MIGRATIONS=1`) applies anyway and still prints
   the findings, the same rules as `guren db:migrate`.
3. **Bookmark.** Before applying, the command records a Time Travel bookmark
   (`cf d1 time-travel get-bookmark <database-id>`) and prints it. On
   failure, the report includes the `cf d1 time-travel restore` command.
4. **Re-list.** Right before applying, the pending set is listed again. If
   it differs from the judged set, the command refuses: another run applied
   migrations in between, so the guard's verdict no longer covers what would
   run.
5. **Apply.** `cf d1 migrations apply <database-id>` with the same arguments.

Stage 6 is skipped when stage 3 found nothing pending on an existing database.

Migrations run before the deploy. In between, and after any rollback, the old
code runs against the new schema. That is exactly the case the guard
protects: an additive migration is safe for the old code, and a destructive
one needed an acknowledgment. `--skip-migrations` leaves stage 6 out.

### 7. Backends and runtime requirements

The stages are written once, against a backend interface:

| Operation | `cf` | `wrangler` |
|-----------|------|------------|
| `checkAuth` | `cf auth list` | `wrangler whoami --json` |
| `evaluateConfig` | `cf build`, then read `worker.config.json` | Parse `wrangler.jsonc` with the plugin's `parseJsonc()` |
| `build(resolved)` | `cf build` | Render `<out>/wrangler.deploy.json` (the developer's config with the resolved IDs filled in, paths rewritten), then the dry-run bundle `reportBundleSize()` already spawns |
| `list` / `create` per type | §4 | Appendix B |
| `pendingMigrations`, `applyMigrations`, `bookmark` | §6 | §6, flat layout only |
| `listSecrets` | `cf workers secrets list` | `wrangler secret list --format json` |
| `deploy` | `cf deploy --prebuilt --no-provision` | `wrangler deploy -c <out>/wrangler.deploy.json --x-provision=false` |
| `rollbackHint` | `cf workers deployments` | `wrangler rollback` |
| `outputDir` | `.guren/cloudflare/` | `.cloudflare/` |

The backend is chosen by which file exists. `cf` is chosen when the app has
`cloudflare.config.ts` and declares `cf`, and new scaffolds get it.
`wrangler` is chosen when only `wrangler.jsonc` exists, so existing apps keep
working with nothing to change until they migrate. The Wrangler backend
never edits `wrangler.jsonc`. It is retired together with Wrangler's
maintenance window.

Floors, which preflight checks only for the chosen backend:

- **The `cf` backend** needs `cf` at the first release this RFC is
  implemented against (1.0.0-beta.18 for Spike D). While `cf` is in beta,
  tests pin the argv contract per command, the same way
  `wrangler-bundle.test.ts` pins the bundle.
  - It needs the Wrangler that `cf` delegates the build to at ≥ 4.136.0,
    which is `cf`'s own constraint (Spike D row 17), and above the 4.129 in
    Guren's lockfile. `guren cloudflare:migrate` raises the dependency.
  - It needs Node ≥ 22.18: loading `cloudflare.config.ts` refuses to run on
    Bun (Spike D row 10). Guren apps otherwise need Bun only, so this adds
    Node to the deploy machine.
- **The `wrangler` backend** needs Wrangler ≥ 4.129.0, the version
  Appendix B's commands were verified against.

Guren never logs in for the developer. Preflight prints `bunx cf auth login`,
or `CLOUDFLARE_API_TOKEN` for CI.

### 8. Reporting the URL and rolling back

Stage 8 prints:

- the URL, the custom domains from the config's routes, and the version ID;
- the resources created and adopted;
- the migrations applied and the Time Travel bookmark;
- the backend's `rollbackHint`, with the warning that a rollback does not
  revert migrations.

### 9. Symmetry with Lambda

| Concern | Lambda (`GurenLambdaApp`) | Cloudflare (this RFC) |
|---------|---------------------------|-----------------------|
| Declaration | CDK props in the developer's stack | `cloudflare.config.ts`, with Guren's part spread in from `gurenWorker()` |
| Engine | `cdk deploy` (CloudFormation) | `cf` (Wrangler during the transition) |
| Job queue | `queue` prop → SQS + DLQ + worker function | Phase 3: Queues producer/consumer + DLQ queue |
| Schedule | `schedule` prop → EventBridge rule | Cron trigger from the task set |
| Migrations | `consoleFunction`, invoked by hand with `db:migrate` | Stage 6, guarded, before deploy |
| Sessions | `sessionsTable` → DynamoDB | `DatabaseSessionStore` on D1, nothing to provision |
| Assets | S3 + CloudFront | Workers Static Assets, nothing to provision |
| Deletion | CloudFormation removal policy | Never deletes, and lists what it created |

Under `cf` the two converge: both are a typed configuration file, owned by
the developer, into which the framework's construct or helper contributes
its part.

### 10. Delivery

**Phase 0: stop blocking the CLI's own provisioning** (patch, Wrangler path)

- The scaffold omits `database_id`, and with `--mcp-oauth` omits the
  `OAUTH_KV` id, instead of writing `TODO:` placeholders. It keeps
  `database_name: <worker>`.
- Two existing messages tell the developer to paste an ID: the scaffold note
  "fill in d1_databases[0].database_id" in `scaffoldWranglerConfig()`, and
  the `OAUTH_KV` placeholder warning in `assertOAuthKvBound()`. Both are
  amended to say the ID may be left out. A build that finds a `TODO:` ID
  names the key to delete.
- The docs change the first deploy to `cloudflare:build` → `wrangler deploy`
  (which creates the database) → `wrangler d1 migrations apply --remote`.
  They say plainly that this leaves a window where code is live before its
  tables exist.
- Phase 0 relies on Wrangler's hidden `--x-provision` default. If Wrangler
  turns it off, an ID-less binding reaches the upload unresolved, and
  `--dry-run` cannot show that failure (Appendix B row 9).

**Phase 1: `cloudflare:deploy` on the `cf` backend** (minor)

- `@guren/plugin-cloudflare/config`, exporting `gurenWorker()`,
  `gurenWranglerBundle()` and `defineCloudflareConfig()`.
- Stages 1–8 and the plan checks, for D1, agent Durable Objects (`exports`),
  `OAUTH_KV` and cron. That includes the `secrets` check, since a first
  deploy without `APP_KEY` does not work.
- The tracker-chosen migration layout (§6) and `.guren/cloudflare/` as the
  output directory.
- The guard needs RFC 0034's `scanMigrationSql()` to ship first.
- `GUREN_INTROSPECT_TARGET`, and an exported `loadScheduleKernel()`.
- `guren deploy --target cloudflare`.
- `guren new` / create-app scaffolds `cloudflare.config.ts`,
  `wrangler.config.ts` and `config/cloudflare.ts` instead of `wrangler.jsonc`.
- The Wrangler backend for the same stages, for apps that have not migrated.
- Tests:
  - the plan and its checks as pure functions over the context;
  - the stages against fake `cf` and `wrangler` executables on `PATH` that
    record their argv;
  - one opt-in live test, skipped without `CLOUDFLARE_API_TOKEN`.

**Phase 2: migration and inference** (minor, plus additive `@guren/orm` and `@guren/cli` changes)

- `guren cloudflare:migrate` (its steps are under Migration Path).
- String binding names on `createD1Database` and `R2Driver`.
- R2 and app KV inference.

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
  `cf migrate --bundler wrangler`, then resolves the follow-up work that
  `cf migrate` leaves for a Guren app (Spike D rows 4–5):
  - replaces the generated binding and bundle entries with `gurenWorker()`
    and `gurenWranglerBundle()`, which also removes the `migrations_dir`
    TODO, since §6 picks the layout from the tracker;
  - converts the agent DO `migrations` to `exports`;
  - writes `config/cloudflare.ts` (`mcpOAuth` from the existing `OAUTH_KV`
    binding);
  - moves the output directory, and raises `wrangler` to the delegate floor;
  - removes the `throw` that `cf migrate` writes, only once all of the above
    are done.

  It then runs `cloudflare:deploy --plan`, which should show nothing to
  create. Whether a deployed DO class keeps its storage when its declaration
  moves from `migrations` to `exports` cannot be checked locally (Open
  Question 5).
- **The closure form of `binding` keeps working.** The string form is what
  docs and new scaffolds teach from phase 2.

## Open Questions

1. **Staged rollout.** Should the staged rollout listed under Later move
   into phase 1?
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
6. **KV namespaces by title.** `bindings.kv()` takes only an ID, so only
   the manifest's `resolved` section pins a KV namespace. A developer who runs
   plain `cf deploy` gets inheritance, or a new namespace. Should the docs
   tell them to deploy only through `cloudflare:deploy` once the app has KV?
7. **Renaming the D1 tracker rows.** §6 keeps an app moved from Wrangler on
   the flat layout with no setting. Is a guarded one-time `UPDATE
   d1_migrations` to `<folder>/migration.sql` worth offering, so that such
   an app can drop the flattened copy?
8. **`cf` beta churn.** How long should the `cf` backend support each beta
   floor before raising it?
9. **Reading the deployed Worker's bindings.** §3.1 reads the active
   version's bindings through `cf workers deployments list` and
   `cf workers versions get`. `cf schema` shows the request but not the
   response shape, so whether that response carries the bound resource IDs
   needs an account to confirm. If it does not, the source falls away, and a
   binding that the deployed Worker holds under another resource is caught
   only by the deploy's `bindings_inherit: strict` behaviour.

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
| 2 | `cf deploy --help` | Has `--provision` ("Automatically provision resources for bindings that need them", default `true`), `--prebuilt`, `--dry-run`, `--secrets-file` | Provisioning is a documented flag |
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
| 15 | Read `@cloudflare/config`'s `public-*.d.mts` | `D1BindingOptions { id?, name? }`, `KvBindingOptions { id? }` (no name), `R2BindingOptions { name?, jurisdiction? }`. `defineConfig` takes `ConfigInput<T> = T \| Promise<T> \| ((ctx) => T \| Promise<T>)` | KV resolves only by ID (§3.1) |
| 16 | `cf deploy --no-provision --dry-run` | Accepted. Lists the bindings and exits at `--dry-run` | The flag exists. Its failure on an unresolved binding needs an account |
| 17 | Read `cf/dist/discover-*.mjs` and `wrangler-migration-*.mjs` | The Wrangler dev-server entry carries `versionConstraint: { range: ">=4.136.0" }`, and `cf migrate` pins `4.136.0` | The delegate Wrangler floor is 4.136.0 (§7) |

Not tried: a real `cf deploy` (it needs an account), and `cf` against a real
Guren build of `.cloudflare/worker.js` (the probe worker stood in for it). The
`cf` help output opens with instructions addressed to coding agents. Those
were treated as tool output, not followed.

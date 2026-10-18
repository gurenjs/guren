# RFC: One-Command Cloudflare Deploy (`guren cloudflare:deploy`)

**Author:** Guren contributors
**Date:** 2026-10-18
**Status:** Draft

> Today a first Workers deploy of a Guren app takes five commands, and one of
> them needs a database ID pasted by hand. This RFC adds `guren cloudflare:deploy`,
> which builds the app, works out which D1/KV/R2/Queues/cron bindings it needs,
> creates the missing ones, applies remote migrations behind the destructive
> migration guard, deploys, and prints the URL. Wrangler stays the deploy
> engine, `wrangler.jsonc` stays the one configuration file, and nothing is
> created that the app cannot name. It also looks at deploying through Void
> instead, and recommends against that for now (Appendix A has the spike).

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
  `--mcp-oauth` the `OAUTH_KV` id gets the same kind of placeholder. Spike C
  (Appendix B) shows this placeholder also *switches off* wrangler's own resource
  provisioning, because wrangler treats a binding that has an `id` as fully
  specified.
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

### The Lambda path is already provisioned

`@guren/plugin-lambda` ships `GurenLambdaApp`, a CDK construct
(`packages/plugin-lambda/src/cdk/index.ts`). One `cdk deploy` creates the
HTTP function and API, an SQS job queue with a dead-letter queue, an
EventBridge schedule rule, a console function for `db:migrate`, an optional
DynamoDB sessions table, and an S3 + CloudFront assets distribution. Every
resource is declared as a prop, so the developer says what exists and CDK
makes it so. The Cloudflare path has no equivalent of that step.

### The competitor

Void (VoidZero, MIT, 1.0 on 2026-10-15, 1.1.11 on 2026-10-15) does all of
this in one command. `void deploy` builds the app, infers D1/KV/R2/AI/Queues
bindings from imports such as `void/db` and from `env.X` accesses, creates
the missing resources, records their IDs in `void.lock.json`, checks schema
drift, applies migrations, uploads a staged version, checks readiness, and
switches traffic. Guren's selling point against it is that one app deploys to
Workers, Vercel, Lambda or a Bun server without lock-in. On Cloudflare,
though, the first-deploy experience is clearly worse.

### Goal

```bash
bunx guren cloudflare:deploy
```

On a clean checkout with `wrangler login` done, this produces a running
deployment and prints its URL. Run again with no changes, it does nothing new
and deploys the same code. Run in CI, it never creates resources it was not
told to create.

Not goals:

- Provisioning resources the app does not use. AI, Vectorize, Hyperdrive,
  Containers and email are left out.
- Named wrangler environments (`env.staging`), which come in a later phase.
- Replacing wrangler, or adding a Cloudflare API client to Guren.

## Prior art (read 2026-10-18)

- **Void 1.1.11.** Read from the docs bundled in the npm package, read in its
  dist code, and run locally in Spike B (Appendix A). Void infers resources by
  scanning source, records provisioned state in `void.lock.json` next to an
  authored `void.config.ts`, and turns a root `wrangler.jsonc` into
  `void.config.ts` (`void migrate`, or the first `void deploy`).
- **Wrangler resource provisioning.** Wrangler has a hidden
  `--experimental-provision` (`--x-provision`) flag that defaults to `true`,
  and a hidden `--x-auto-create` that also defaults to `true`. On
  `wrangler deploy` and `wrangler versions upload`, each `kv_namespace`,
  `d1`, `r2_bucket` or `queue` binding that has no ID is resolved in one of
  three ways:
  1. inherited from the deployed Worker's current bindings;
  2. matched to an existing resource of the same name;
  3. created, under the configured name or `<worker>-<binding>`.

  Wrangler 4.129.0, the version in Guren's `bun.lock`, does this already.
  4.151.0 also writes the new IDs back to the config, but only in interactive
  runs. Spike C has the details.
- **`GurenLambdaApp`.** Resources are declared explicitly, and the IaC tool
  owns creation, update and deletion. It is the shape this RFC mirrors.

## Options

**A. Guren-owned orchestration.** A `cloudflare:deploy` command in the
plugin. It infers the binding set, reconciles it into `wrangler.jsonc`,
creates missing resources through wrangler's documented subcommands, applies
remote migrations behind the guard, and runs `wrangler deploy`.

**B. Ride Void's deploy layer.** Have `cloudflare:build` emit something
`void deploy` accepts, and send users to Void for provisioning and deployment.

**C. Lean on wrangler's provisioning.** Stop writing placeholder IDs, so that
plain `wrangler deploy` creates the D1/KV/R2/Queue resources itself. Guren
only writes the bindings and runs the commands in order.

**Recommendation: A, built on C.** Phase 0 is C alone: a scaffold change of a
few lines that takes the first deploy from five commands to three, with no
new command. Phases 1 to 3 are A. The provisioning step in A calls documented
wrangler subcommands rather than relying on the hidden flag, so the
`guren cloudflare:deploy` path does not depend on an experimental feature.
Meanwhile, a developer who runs `wrangler deploy` directly still gets
wrangler's provisioning. Option B is not recommended at Void 1.1.11 (see the
Option B section). The reasons are below.

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
| 1 | Preflight | `wrangler --version` must be at least the floor version (§7). `wrangler whoami --json` is the account check. Refuses `wrangler.json` or `wrangler.toml` the way the build already does (`assertWranglerJsoncIsAuthoritative()`). | nothing |
| 2 | Build | `buildCloudflareOutput()`, the same code `cloudflare:build` runs, with the same flags. | `.cloudflare/` |
| 3 | Plan | Infers the desired bindings (§2) and diffs them against `wrangler.jsonc` and the account (§4 lookups). Prints the plan. `--plan` stops here with exit 0, or exit 1 if the plan has blockers. | nothing |
| 4 | Reconcile | Applies the plan's config edits to `wrangler.jsonc`, keeping comments (§3). | `wrangler.jsonc` |
| 5 | Provision | Creates each planned resource that does not exist yet and writes its ID back (§4). | account, `wrangler.jsonc` |
| 6 | Secrets | Checks that every required server variable in `config/env.ts` exists as a Worker secret or var. If any is missing, refuses and prints the `wrangler secret put` command for each (§5). | nothing |
| 7 | Migrate | Lists the pending remote D1 migrations, judges them with the RFC 0034 scanner, captures a Time Travel bookmark, and applies them (§6). | D1 |
| 8 | Deploy | `wrangler deploy` with the generated config. | Worker |
| 9 | Report | Prints the URL, what was created, migrated and deployed, and the rollback commands (§8). | nothing |

Without `--yes`, a TTY asks once, after stage 3, before anything is written.
The prompt shows the whole plan: resources to create, config edits,
migrations to apply, and cron changes. The other runs (`--yes`, `--ci`, or
no TTY) skip the prompt and follow the rules in §4 instead.

`--json` prints one object: `{ plan, created, migrated, deployment, url }`.
It is the agent-facing form, the same convention as `guren check --json` and
`browser:serve`.

`cloudflare:build` stays as it is: it assembles output and edits nothing
outside it except the one-time scaffold. A developer who wants to drive
wrangler by hand keeps that path. `cloudflare:deploy` is a superset of it.

### 2. Which bindings an app needs

Void infers bindings from imports and `env.X` patterns. A Guren app does not
use either shape. Bindings arrive through a closure,
`binding: () => getWorkersEnv<Env>().DB`, and the driver is picked at runtime
by `isWorkersRuntime() ? createD1Database(...) : createSqliteDatabase(...)`.
Spike B confirms the gap: `void info --json` reports no resources at all for
`examples/agents`, even though it uses D1 and a Durable Object. Scanning the
source the way Void does would therefore find nothing in a Guren app. Guren
already has a better source: it can *ask the app*.

| Binding | Source of truth | Phase |
|---------|-----------------|-------|
| `d1_databases` `DB` | Already build-owned. The scaffold writes it, and `warnDatabaseWithoutD1()` exists. Confirmed by the introspected `database` section once §2.1 lands (`dialect: 'd1'`). | 1 |
| Durable Objects + `migrations` | `config/agents.ts`, already read by `readAgentRegistry()`. Today a missing entry fails the build and prints the JSON to paste. Under `cloudflare:deploy` that JSON becomes a planned edit instead. | 1 |
| `kv_namespaces` `OAUTH_KV` | `--mcp-oauth`, already build-owned in that mode. | 1 |
| `triggers.crons` | The schedule kernel, read the way `guren schedule:list` reads it: one `* * * * *` trigger whenever any task is registered, because the worker runs whichever tasks are due at each firing. If the kernel cannot be read, the plan does not touch `triggers` and says so. That keeps today's rule against guessing. | 1 |
| `r2_buckets` | Storage disks whose driver is `R2Driver`, from the introspected `storage` section, with the binding name taken from the driver's description (§2.1). | 2 |
| `kv_namespaces` (app) | Any KV-backed driver that describes a binding name the same way. No such driver ships today. The row is here so the rule exists before one does. | 2 |
| `queues.producers` / `consumers` | `config/queue.ts` with a Cloudflare Queues driver. That driver and the generated worker's `queue()` handler do not exist yet. They are a prerequisite, not part of provisioning (§9, phase 3). | 3 |

Inference only ever **adds**. A binding the developer wrote is never edited
or removed. When inference and the file disagree, the plan reports a
blocker and changes nothing. For example, the app has an R2 disk on `MEDIA`
but the file binds `MEDIA` to a KV namespace. A binding in the file that
nothing infers is left alone, since an app can read `env.X` directly.

#### 2.1 Making Workers bindings visible to introspection

`guren introspect` runs `register()` under Bun, where `isWorkersRuntime()` is
false. The manifest therefore describes the *development* branch: `sqlite`,
`local` disks. The Workers branch is invisible. Two small, additive changes
fix this:

1. **A target override for introspection.** Under `GUREN_INTROSPECT=1` plus
   `GUREN_INTROSPECT_TARGET=cloudflare`, `isWorkersRuntime()` returns true.
   This is safe because every Workers binding is already read lazily. RFC 0003
   requires it, and `getWorkersEnv()` throws with that advice. So `register()`
   builds the D1 factory and the R2 disk without touching an env that does not
   exist. `cloudflare:deploy` introspects with
   `guren introspect --json --target cloudflare`.
2. **Bindings named as strings.** `createD1Database({ binding: 'DB' })` and
   `new R2Driver({ binding: 'MEDIA' })` accept the binding *name*. They
   resolve it through `getWorkersEnv()` per request, the same as the closure
   form, and report it from `describe()`. For example, the database
   description gains `binding?: string`, and storage entries gain
   `binding?: string` next to `driver`. The closure form keeps working. A
   closure is opaque, so for it the plan falls back to the build-owned `DB`
   and prints a hint to switch to the string form.

The string form is what docs and scaffolds teach from phase 2 on. It is also
shorter than the closure it replaces.

### 3. Editing `wrangler.jsonc`

`wrangler.jsonc` stays the only configuration file. It is what wrangler reads,
what `wrangler dev` uses, and what the developer already edits. Generating
the real config from a second file, the way Void generates
`.void-wrangler.jsonc` from `void.config.ts` plus `void.lock.json`, would
make the committed file a build input that nobody reads directly. That is a
second source of truth this RFC avoids.

Every key falls into exactly one class:

| Class | Keys | On every deploy |
|-------|------|-----------------|
| Build-owned | `main`, `alias` entries the build needs, `define['process.env.NODE_ENV']`, `define['import.meta.url']`, `assets.directory`, `d1_databases[DB].migrations_dir`, agent `durable_objects` and `migrations` entries | Set to the value the build needs. These are the keys `warnMissingBuildOwnedKeys()` warns about today. The warning becomes an edit. |
| Inferred | Bindings from §2 that the file lacks, and resource IDs from §4 | Appended once. After that the entry belongs to the developer. |
| Developer | Everything else | Never touched. |

Edits keep comments and formatting. The plugin's `parseJsonc()` is read-only,
so the edits go through `jsonc-parser` (`modify()` + `applyEdits()`, MIT, the
library VS Code uses, and the one Void uses for the same job). It is added as
a dependency of `@guren/plugin-cloudflare` only, never of the core packages.
`examples/agents/wrangler.jsonc` already carries explanatory comments, so a
`JSON.stringify` rewrite is not acceptable.

`cloudflare:build` keeps the `wx` scaffold. It gains an opt-in
`--write-config` flag that applies the build-owned edits. `cloudflare:deploy`
applies them always.

**Where resource IDs live.** IDs are written into `wrangler.jsonc`
(`database_id`, `id`, `bucket_name`), not into a lock file. D1 and KV IDs
are identifiers, not credentials. Using one needs an API token for the
account, and this repository already commits one (`examples/agents/wrangler.jsonc`). Keeping them in the file
wrangler reads means `wrangler dev`, `wrangler tail` and
`wrangler d1 execute` keep working with no Guren step in between. A Guren
lock file would mean either generating the real config (rejected above) or
keeping two copies in sync.

**Secrets are never written to `wrangler.jsonc`.** See §5.

### 4. Provisioning

Provisioning is its own stage, before upload, run through documented wrangler
subcommands:

| Resource | Lookup | Create |
|----------|--------|--------|
| D1 | `wrangler d1 list --json`, by `database_name` | `wrangler d1 create <name>` |
| KV | `wrangler kv namespace list`, by title | `wrangler kv namespace create <name>` |
| R2 | `wrangler r2 bucket list`, by name | `wrangler r2 bucket create <name>` |
| Queue | `wrangler queues list`, by name | `wrangler queues create <name>` |

`<name>` is the deterministic name from the first rule below.

The command does not use wrangler's implicit provisioning for two reasons.

- **Migrations must run before the new code takes traffic.** Implicit
  provisioning happens inside `wrangler deploy`, after which the new code is
  live against an empty database. Creating the database first gives the
  order create → migrate → deploy.
- **That path is hidden and labelled experimental.** Its behaviour has
  already changed between 4.129 and 4.151 (ID write-back was added). The
  subcommands above are stable and documented.

Rules:

- **Names are deterministic.** A resource the plan creates is named
  `<worker>` for the D1 database, the name `cloudflare:build` already
  scaffolds, and `<worker>-<binding>` lowercased for the others. That is
  wrangler's own `autoProvisionedResourceName()`, so plain `wrangler deploy`
  and `cloudflare:deploy` agree on names.
- **Idempotent by lookup.** If the lookup finds a resource with the planned
  name, the plan adopts it and does not create a second one. The plan prints
  "adopted" separately from "created", because adopting a resource that
  another project created under the same name is a real risk. A rerun after
  any failure converges: the account and `wrangler.jsonc` are the only state,
  and both are read again at stage 3.
- **CI does not create by default.** With `--ci`, or no TTY and no `--yes`,
  a binding with no ID and no matching resource is a blocker unless
  `--provision` is passed. A first deploy from CI that silently creates
  databases is the failure Void's docs warn about ("Run the first deploy
  from one machine at a time"). This makes it opt-in. Apart from the
  provisioning rule, CI runs behave the same as `--yes`.
- **Nothing is ever deleted.** If a later stage fails, the report lists what
  this run created, with the delete commands. It does not run them: a D1
  database may already hold migrated tables, and only the developer can tell
  an empty one from a precious one. Removing a binding from the app does not
  delete its resource either, the same as Void's `void project delete`.
- **No locking.** Two concurrent first deploys can both find nothing and
  both create. The lookups make the second run adopt only if it starts after
  the first one finished. The docs say to run the first deploy from one
  machine, and commit `wrangler.jsonc` with its IDs before running from CI.
  A real lock would need state outside the account, and nothing else needs
  that.

### 5. Secrets

`config/env.ts` (RFC 0027) declares which server variables are required.
Stage 6 compares that list with `wrangler secret list --format json` plus
`vars`. If any required variable is missing, the command refuses before
anything is uploaded and prints one command per missing name:

```
Missing Worker secrets: APP_KEY, ANTHROPIC_API_KEY
  bunx wrangler secret put APP_KEY
  bunx wrangler secret put ANTHROPIC_API_KEY
```

It never reads `.env` or `.dev.vars` to upload values. A local development
value is not a production value, and Void draws the same line ("Local `.env`
values are never deployed"). Uploading values in bulk stays an explicit
`wrangler secret bulk` run by the developer.

### 6. Remote migrations and the destructive guard

RFC 0034 (destructive migration guard, Draft) adds `scanMigrationSql()` to
`@guren/orm`, a `-- guren:allow-destructive` acknowledgment marker, and
`--allow-destructive`. It records that for D1 "`wrangler d1 migrations apply`
... Guren never runs", so its D1 guard is the `guren check` rule over files
not yet on the base branch. `cloudflare:deploy` changes that, and the guard
becomes exact for D1:

1. `wrangler d1 migrations list DB --remote` gives the migrations the remote
   database has not applied.
2. Each pending file in `.cloudflare/d1-migrations/` maps back to its
   `db/migrations/<folder>/migration.sql` through `flattenD1Migrations()`'s
   own naming, and is judged with `scanMigrationSql()`. An unacknowledged
   finding refuses the deploy with exit 1, naming `<folder>/migration.sql:<line>`.
   `--allow-destructive` (or `GUREN_ALLOW_DESTRUCTIVE_MIGRATIONS=1`) applies
   anyway and still prints the findings, the same rules as `guren db:migrate`.
3. Before applying, the command records the Time Travel bookmark
   (`wrangler d1 time-travel info DB --json`) and prints it. If the apply or
   the deploy fails, the report includes the `wrangler d1 time-travel restore`
   command for that bookmark.
4. `wrangler d1 migrations apply DB --remote`.

Migrations run before the deploy. For the time between the two, and for any
rollback afterwards, the *old* code runs against the *new* schema. That is
exactly the case the guard protects: an additive migration is safe for the
old code, and a destructive one needed an explicit acknowledgment.
`--skip-migrations` leaves stage 7 out for apps that migrate through their
own pipeline.

The build already regenerates `.cloudflare/d1-migrations` at stage 2. That
removes the empty-directory pitfall the guide warns about, since the apply
can no longer run before the build.

### 7. Wrangler is a dependency, with a floor

The command shells out to `wrangler`. It resolves the app's own installed
copy first and refuses one older than a floor version, at first 4.129.0, the
version in Guren's lockfile, which Spike C ran. It adds `wrangler` to the
plugin's `peerDependencies` (optional) with that range, so a package manager
warns early. Guren never logs in on the developer's behalf. Preflight runs
`wrangler whoami` and, if it fails, prints `bunx wrangler login`, or
`CLOUDFLARE_API_TOKEN` for CI.

### 8. Reporting the URL and rolling back

The workers.dev URL comes from the account subdomain (`wrangler whoami` does
not print it, so the command reads it from wrangler's deploy output and falls
back to `https://<worker>.<subdomain>.workers.dev`). Custom domains come from
`routes` in `wrangler.jsonc`. Stage 9 prints:

- the URL;
- the version ID;
- resources created and adopted;
- migrations applied and the Time Travel bookmark;
- `bunx wrangler rollback <previous-version>`, with the warning that rollback
  does not revert migrations.

### 9. Symmetry with Lambda

| Concern | Lambda (`GurenLambdaApp`) | Cloudflare (this RFC) |
|---------|---------------------------|-----------------------|
| Declaration | CDK props in the developer's stack | `wrangler.jsonc`, with the inferred bindings appended |
| Engine | `cdk deploy` (CloudFormation) | `wrangler` subcommands + `wrangler deploy` |
| Job queue | `queue` prop → SQS + DLQ + worker function | Phase 3: `queues` producer/consumer + DLQ queue |
| Schedule | `schedule` prop → EventBridge rule | `triggers.crons` from the schedule kernel |
| Migrations | `consoleFunction`, invoked by hand with `db:migrate` | Stage 7, guarded, before deploy |
| Sessions | `sessionsTable` → DynamoDB | `DatabaseSessionStore` on D1 (RFC 0003 §3), nothing to provision |
| Assets | S3 + CloudFront | Workers Static Assets, nothing to provision |
| Deletion | CloudFormation removal policy (CDK default RETAIN for tables) | Never deletes, and lists what it created |

The two differ in one way. Lambda resources are declared by the developer,
while Cloudflare bindings are inferred and appended. The result is the same:
after the first deploy, the committed file declares everything that exists.
A developer who wants Lambda-style explicitness writes the bindings
themselves, and inference then has nothing to add.

## Option B: deploying through Void

Spike B (Appendix A) ran `void@1.1.11` against a copy of `examples/agents`
and a minimal fixture shaped like `.cloudflare/worker.js`. Nothing was
deployed to any account. What it showed:

1. **Void owns the Worker entry.** `vite build` with `voidPlugin()` writes
   `.void/entry.ts`, a generated `export default class extends WorkerEntrypoint`
   whose `fetch`, `scheduled` and `queue` dispatch into Void's own routing.
   The deploy code overwrites `main` in the generated config with its build
   output (`upsert(["main"], options.main)` in `@void/deploy-cloudflare`).
   `inference.appType` accepts only `void`, `framework`, `spa` and `static`.
   No type takes an arbitrary Worker module, and Void's own migration skill
   for existing Cloudflare apps rewrites them into `routes/` files.
2. **A Guren app can be carried, but only through a shim.** A catch-all
   `routes/[...path].ts` that forwards `c.req.raw`, `c.env` and
   `c.executionCtx` to the Hono app served GET and POST and reached D1 under
   `wrangler dev`. That works for HTTP only. Every other entry point needs its
   own Void-shaped shim:
   - the `scheduled` handler would move to `crons/`;
   - each agent Durable Object would need a `durable-objects/<name>.ts` that
     wraps it with `defineDurableObject()`. Without one, the class
     (`Triager` in the fixture) is dropped from the bundle, because the
     generated entry exports only what Void discovers;
   - the build-owned `alias` / `define` that let Guren's worker bundle under
     esbuild (`bun:sqlite`, `@guren/cli` stubs, `import.meta.url`) would have
     to become Vite `resolve.alias` / `define`, because Void bundles with Vite
     and sets `no_bundle: true` for wrangler.

   That means `cloudflare:build` would generate a second, Void-shaped app
   around the first. That is more code than Option A's provisioning step, and
   it sits on Void internals with no stability promise.
3. **Inference sees nothing in a Guren app.** `void info --json` reported
   `resources: []` for `examples/agents`. With
   `inference: { bindings: { db: true } }`, the build did produce a `DB`
   binding, but named `default`, with Void's own `migrations_dir`.
4. **Migrations do not line up.** `void db status` on `examples/agents`
   reported "No migration files found in db/migrations/". Guren writes
   drizzle 1.0's folder-per-migration layout
   (`<timestamp>_<name>/migration.sql`). Void reads drizzle-kit 0.31's
   `meta/_journal.json`, and its deploy-time drift check would ask to
   regenerate the history. Void also depends on `drizzle-orm ^0.45`, while
   Guren is on `1.0.0-rc.4`. That is two drizzle majors in one app's
   dependency tree, and schema objects of one are not values of the other.
5. **Void takes over `wrangler.jsonc`.** `void migrate`, which the first
   `void deploy` also runs, moved the root `wrangler.jsonc` to
   `.void/config-migration/` and wrote `void.config.ts` + `void.lock.json`,
   dropping the file's comments. The next `cloudflare:build` would then see
   no `wrangler.jsonc` and scaffold a fresh one with a placeholder ID. The two
   tools would fight over the same file.
6. **The toolchain is heavier.** `void` needs Node ≥ 24.21 (`engines`), and it
   ran with only a warning on 24.18. It pulls better-auth, pg, mysql2,
   better-sqlite3, miniflare, and its own drizzle-kit into the app. Guren's
   toolchain otherwise needs Bun only.

Trade-offs:

| | A (Guren-owned, on wrangler) | B (Void) |
|---|---|---|
| Lock-in | None beyond Cloudflare itself. The output is a plain wrangler project, and every step is a wrangler command the developer can run by hand. | Adds Void as a second framework on top of Guren. `void.config.ts` and `void.lock.json` replace `wrangler.jsonc`. |
| Maintenance | New command and inference code in one plugin, plus a `jsonc-parser` dependency. It moves at wrangler's pace, and wrangler's CLI is stable. | A shim generator against Void internals (entry shape, `durable-objects/` discovery, Vite build) that changed weekly through 0.26 → 1.1.11. |
| Maturity | Wrangler is Cloudflare's official, long-lived CLI. Its implicit provisioning is the only experimental part, and A does not depend on it. | 1.x for three days at the time of writing. Framework mode covers six meta-frameworks and not a custom Hono app. |
| Relation to Cloudflare | Uses Cloudflare's own tooling the documented way. Plain `wrangler deploy` keeps working. | VoidZero sits between Guren and Cloudflare. Void calls wrangler and Cloudflare's `cf` CLI underneath. |
| Features | D1/KV/R2/Queues/cron/DO, guarded migrations, URL. No staged readiness check at first (open question). | Staged upload + readiness + automatic rollback, ISR, email, and AI come for free once the shim works. |

The one thing B has that A lacks at first is the staged rollout with a
readiness check and automatic rollback. That is a reason to revisit, not a
reason to adopt. Revisit when Void offers an app type that takes an existing
Worker module and its `exports` as-is, reads drizzle 1.0 migrations, and
leaves `wrangler.jsonc` in place. Appendix A's commands are the test.

## Implementation plan

**Phase 0: stop blocking wrangler's own provisioning** (patch, `@guren/plugin-cloudflare`)

- The scaffold omits `database_id`, and with `--mcp-oauth` omits the
  `OAUTH_KV` id, instead of writing `TODO:` placeholders. It keeps
  `database_name: <worker>`, so `wrangler d1 migrations apply <name>
  --remote` can find the auto-provisioned database by name.
- When an existing config has a `TODO:` ID, the build warns and names the
  key to delete.
- Docs (`docs/{en,ja}/guides/cloudflare.md`): the first deploy becomes
  `cloudflare:build` → `wrangler deploy` (which creates the database) →
  `wrangler d1 migrations apply --remote`. The guide must say clearly that
  for a first deploy this leaves a window where the code is live before its
  tables exist, and that phase 1 closes it.

**Phase 1: `cloudflare:deploy` for what the plugin already owns** (minor)

- Stages 1–9 for D1, agent Durable Objects, `OAUTH_KV`, and cron.
- `jsonc-parser` edits for build-owned keys. `cloudflare:build --write-config`.
- Remote migrations guarded by RFC 0034's scanner. This needs RFC 0034's
  `scanMigrationSql()` to ship first.
- Tests: plan and reconcile as pure functions over config text. Stage
  orchestration against a fake `wrangler` executable on `PATH` that records
  its argv and returns canned JSON. The wrangler argv contract is pinned the
  same way `wrangler-bundle.test.ts` pins the bundle. One opt-in live test
  against a real account, skipped without `CLOUDFLARE_API_TOKEN`.

**Phase 2: R2 and app KV** (minor, plus additive `@guren/orm` / `@guren/cli` changes)

- String binding names on `createD1Database` / `R2Driver`, and `binding` in
  `describe()`.
- `guren introspect --target cloudflare`.
- The secrets check (stage 6).

**Phase 3: Cloudflare Queues** (minor; its own RFC)

- A Cloudflare Queues driver for `QueueManager`, a `queue()` export in the
  generated worker, and a DLQ convention mirroring `GurenLambdaApp`'s.
- Provisioning then gains queue producers and consumers.

**Later:** named environments (`--env`), a staged upload with
`wrangler versions upload` → readiness probe → `wrangler versions deploy`,
and revisiting Option B.

## Alternatives Considered

**Option C alone, with no new command.** Phase 0 already gets most of the
provisioning for free. It still leaves the developer to order three
commands, gives no guard on remote migrations, gives code-before-schema on
the first deploy, has no cron or Durable Object edits, and depends on a
hidden flag. It is a good first step and a poor end state.

**Terraform or Pulumi (Cloudflare provider).** This would mirror the Lambda
CDK construct most closely, since it is declarative IaC owned by a real
engine. But it is a second toolchain and a state backend for apps whose
whole infrastructure is a handful of bindings. Wrangler already knows how to
create each of them. An app that already uses Terraform can keep doing so:
`cloudflare:deploy --skip-migrations` with every ID present only deploys.

**Cloudflare's `cf` CLI (1.0.0-beta.18).** This is the newer official CLI
that Void depends on. It is still in beta. Wrangler stays the engine until
`cf` is stable, and the subcommand table in §4 is the only place that would
change.

**Calling the Cloudflare REST API directly.** That means token handling,
pagination, and an API surface Guren would have to keep up with. Wrangler
already does all of this and handles authentication. Not worth it for four
create calls.

**A Guren lock file for resource IDs, as Void does.** Rejected in §3:
`wrangler.jsonc` is already committed and already read by every tool that
needs the IDs.

## Migration Path

- Nothing changes for an app that keeps using `cloudflare:build` +
  `wrangler deploy`, except the phase-0 warning on a `TODO:` ID.
- An existing app runs `cloudflare:deploy --plan` first. Its IDs are already
  in `wrangler.jsonc`, so the plan should show no resources to create, only
  build-owned edits and any missing cron. The first real run adopts what
  exists.
- The closure form of `binding` keeps working. The string form is what docs
  and new scaffolds teach from phase 2.

## Open Questions

1. **Staged rollout.** Should phase 1 deploy with
   `wrangler versions upload` + `versions deploy`, which allows a readiness
   probe before traffic? Or plain `wrangler deploy` first? Wrangler's
   versions flow has had restrictions around Durable Object migrations, and
   this must be checked against the floor version before choosing.
2. **Adoption by name.** Is adopting an existing same-named resource the
   right default, or should adoption need `--adopt` outside a TTY? Wrangler
   adopts by name without asking. Void adopts through `void.lock.json` only.
3. **Cron granularity.** A single `* * * * *` trigger is correct for every
   kernel, but it fires 1,440 times a day even when the finest task is
   hourly. Should the plan compute the coarsest trigger that still serves the
   finest task, given that `runDueTasks()` runs what is due at each firing?
4. **D1 read replication.** Void turns it on when it creates a database.
   Guren's D1 driver does not open sessions (`withSession()`) yet, so this
   RFC leaves it off.
5. **Where the plan lives for agents.** Should `cloudflare:deploy --plan
   --json` be wired into `guren gate` or the harness Stop hook (RFC 0008) as
   a read-only check? Or kept as a command the agent runs before asking the
   developer to deploy?

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

Not tried: the real `.cloudflare/worker.js` of `examples/agents` through the
shim (its `alias`/`define` would need Vite equivalents), `void deploy`
itself (it needs a Cloudflare login and creates resources), and `void/db`
running against `@guren/orm`'s D1 driver in one bundle (blocked earlier by
the drizzle major mismatch in item 6 and §Option B.4).

## Appendix B: Spike C — wrangler's resource provisioning (2026-10-18)

| # | Command | Result |
|---|---------|--------|
| 1 | Read `wrangler-dist/cli.js` of 4.151.0 and 4.129.0 | Both: hidden `experimental-provision` (alias `x-provision`, default `true`) and `experimental-auto-create` (alias `x-auto-create`, default `true`). `provisionBindings()` runs in both `deployWorker()` and `uploadWorkerVersion()`. Provisionable types: `kv_namespace`, `d1`, `r2_bucket`, `queue` (plus AI Search, agent memory, dispatch namespaces, Flagship). A binding without an ID inherits from the deployed Worker's settings, connects to an existing resource, or is created. The default name is `${scriptName}-${binding.toLowerCase().replaceAll("_", "-")}`. |
| 2 | Same | 4.151.0 adds `writeProvisionedIdsToConfig()`, skipped when `isNonInteractiveOrCI()`. In CI the IDs are not written back ("future deploys will continue to work even without IDs" via inheritance). 4.129.0 has no write-back. |
| 3 | `wrangler@4.151.0 deploy --dry-run` and `wrangler@4.129.0 deploy --dry-run` with `d1_databases: [{ binding: "DB", database_name: "…" }]`, `kv_namespaces: [{ binding: "CACHE" }]`, `r2_buckets: [{ binding: "MEDIA" }]`, a queue producer and a cron, all without IDs | Both validate and list the four bindings, then stop at `--dry-run: exiting now.` |
| 4 | Read the handler base class | `shouldProvision()` returns false when the binding `isFullySpecified()`. A placeholder such as `database_id: "TODO: wrangler d1 create"` counts as specified, so today's scaffold opts out of provisioning (phase 0). |
| 5 | `wrangler@4.151.0 dev` on the same config; `curl /` | The D1 query is served by the local miniflare database. A missing `database_id` does not break local development. |
| 6 | `wrangler@4.151.0 d1 migrations apply DB --local` | `0001_init.sql ✅`. Both versions contain the "Couldn't find an auto-provisioned D1 DB named …" lookup that `--remote` uses to resolve an ID-less binding by name. |

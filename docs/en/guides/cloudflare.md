# Cloudflare Workers Deployment

Guren runs on Cloudflare Workers via `@guren/plugin-cloudflare`, with D1 as the database. This guide covers the full path from an empty account to a deployed app.

Workers is a different shape of runtime from a long-lived server: there is no filesystem, no shared memory between requests, and a CPU budget measured in milliseconds. Most of this guide is about the handful of places where that changes how an app is configured.

## Install

```bash
bunx guren plugin @guren/plugin-cloudflare
bun add @guren/plugin-cloudflare
```

The plugin registers a `cloudflare:build` command and scaffolds `wrangler.jsonc` on the first build.

## Build and Deploy

```bash
bunx guren cloudflare:build
bunx wrangler deploy
```

`cloudflare:build` runs your app's `build` script, then assembles a `.cloudflare/` directory containing the worker entry, static assets, and flattened database migrations. Wire both steps into one script so nobody deploys a stale worker:

```json
{
  "scripts": {
    "cloudflare:build": "bun run build && bunx guren cloudflare:build --skip-app-build",
    "deploy:cloudflare": "bun run cloudflare:build && bunx wrangler deploy"
  }
}
```

> [!IMPORTANT]
> `.cloudflare/` is generated output, so add it to `.gitignore` and rebuild before every deploy. Nothing else reads from it, so a stale directory silently ships old code.

Before the app build it runs the deploy-runtime checks `guren doctor` reports and warns, without failing, when sessions or OAuth state would sit in process memory, a [Bun-only password hasher](/docs/guides/authentication#password-hasher) is selected, or providers are discovered from the filesystem. Each works locally and breaks on Workers, and the warning prints where you are still reading rather than after the Vite output.

These checks read the app as Workers runs it. While the build introspects the app, `isWorkersRuntime()` from `@guren/plugin-cloudflare/env` returns true, so a config that branches on it is judged on its Workers branch (D1, not SQLite), while `guren doctor` and `guren check` keep reading the branch `bun run dev` takes. Reading a binding while the app registers, rather than behind a closure, fails that introspection, and the checks then report what they could not verify.

The build also refuses a `wrangler.jsonc` that sets `"keep_names": false`, at the top level or in any `env.<name>` block. Guren keeps class names in records that outlive a deploy: queued jobs, queued events and stored notifications are keyed by class name unless they pin `static jobName`, `static eventName` or a `type` getter, and a [durable agent](./durable-agents.md) is found by its class name. wrangler bundles with esbuild's `keepNames` on unless `keep_names` turns it off, so `"minify": true` alone keeps those names. With `keep_names` off, minification renames every class, and even an unminified bundle renames the second of two top-level classes that share a name (`OrderShipped2`). Records the previous deploy wrote then stop resolving.

## Database (D1)

The scaffolded `wrangler.jsonc` binds the database by name and leaves out `database_id`:

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app",
      "migrations_dir": ".cloudflare/d1-migrations"
    }
  ]
}
```

On a binding with no id, `wrangler deploy` (Wrangler 4.129 or later) looks for a database named `database_name` and creates it if there is none. A later deploy keeps the database the deployed worker is bound to, so there is no id to copy anywhere. The lookup is by name across the whole account: if another project already has a database called `my-app`, the deploy binds to it, so pick a `database_name` that is unique on the account. Wrangler 4.151 and later also write the new id back into `wrangler.jsonc` when you deploy from a terminal; a CI deploy leaves the file alone and relies on the same lookup.

To use a database you created yourself, run `bunx wrangler d1 create my-app` and add the id it prints as `"database_id"`. Do not leave a made-up value there: Wrangler skips provisioning for any binding that carries an id, so a placeholder fails the deploy. Apps scaffolded by an older plugin have `"database_id": "TODO: wrangler d1 create"`; before the app build runs, the build warns about any id that is not hex (or is all zeros) until you delete the key.

Select the driver by runtime in `config/database.ts`. D1 speaks SQLite, so write your schema in the SQLite dialect and keep a local SQLite file for development:

```typescript
// config/database.ts
import { createD1Database, createSqliteDatabase, defineDatabaseConfig } from '@guren/core'
import { isWorkersRuntime } from '@guren/plugin-cloudflare/env'
import env from './env.js'

const database = isWorkersRuntime()
  ? createD1Database({
      binding: 'DB',
      migrationsFolder: new URL('../db/migrations', import.meta.url),
    })
  : createSqliteDatabase({
      migrationsFolder: new URL('../db/migrations', import.meta.url),
      seedersFolder: new URL('../db/seeders', import.meta.url),
      // `context` is the app's validated environment; `guren db:*` runs outside one and parses the schema itself.
      filename: (context) => (context?.env ?? env.parse(undefined, { mode: 'report' }).values).SQLITE_DATABASE_PATH,
    })

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database

export default defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })
```

Declare `SQLITE_DATABASE_PATH: Env.string().default('./data/guren.db')` in `config/env.ts` and list `database` in `createApp({ config })`; the [Configuration guide](./configuration.md#the-database-connection) covers the resolver. Import `isWorkersRuntime` from `@guren/plugin-cloudflare/env`: the package root also carries the build tooling, which has no place in the worker bundle.

`binding` names the binding rather than holding it: bindings only exist once a request arrives, so the factory reads `DB` from the Workers env at the first query. Naming it also lets the introspected app report which binding the database uses, on the branch Workers takes (`guren introspect --target cloudflare --json`). The older form, a closure such as `() => getWorkersEnv<Env>().DB`, still works, but nothing outside the closure can see the name.

### Applying migrations

Migrations are applied out of band, since the app never migrates itself on Workers:

```bash
bunx guren cloudflare:build          # regenerates .cloudflare/d1-migrations
bunx wrangler d1 migrations apply my-app --remote
```

On the first deploy the database does not exist until `wrangler deploy` creates it, so the order is build, deploy, then migrate:

```bash
bunx guren cloudflare:build
bunx wrangler deploy
bunx wrangler d1 migrations apply my-app --remote
```

Until the last command finishes, the new worker is live against an empty database and any request that reads a table fails. Run the three back to back, or create the database with `wrangler d1 create` beforehand and migrate before the first deploy.

Wrangler applies whatever the folder holds, so Guren's destructive-migration
guard cannot run at that point. `bunx guren check` (and `bunx guren gate`) judge
the migrations your branch adds before they are merged, and report a `DROP`,
a narrowed type or a table rebuild that carries no
`-- guren:allow-destructive` comment. That makes the pull request the guard: run
`bunx guren check --ci` in its CI with the full history (`fetch-depth: 0`), and
merge only when it passes. On `main` itself the check treats every committed
migration as shipped and judges nothing, so running it there right before
`--remote` proves nothing about what wrangler is about to apply.
[Destructive migrations](./database.md#destructive-migrations) covers what it
reports. D1 keeps foreign keys on during a migration, so a rebuild of a table
that another table references with `ON DELETE CASCADE` is reported here even
though it copies every column.

> [!WARNING]
> Build first. `migrations_dir` points inside the generated directory, and `wrangler` reports "no migrations to apply" — successfully, with no error — when it finds an empty folder. Applying before building is the one failure here that looks like success.

The worker never seeds itself either. `defineDatabaseConfig` seeds only when `seedOnBoot` is true and the database reports migrations; `cloudflare:build` pins `NODE_ENV` to `production`, and a D1 handle reports none, since it has no filesystem to look in. Locally, `bun run dev` takes the SQLite branch and seeds on boot once migrations exist.

### Deploying in one command

`bunx guren cloudflare:deploy` runs the steps above in an order that leaves no window on an empty database. It builds, creates the D1 database (and `OAUTH_KV`) when it is missing, applies the pending migrations through the destructive-migration guard, then deploys:

```bash
bunx guren cloudflare:deploy --plan   # shows what it would do and writes nothing
bunx guren cloudflare:deploy
```

It reads `wrangler.jsonc` and never writes it. The ids it resolves go into `.cloudflare/wrangler.deploy.json`, a copy of your config that it deploys with `wrangler deploy -c`, and into `.cloudflare/guren-worker.json`. The build lists both in a `.gitignore` inside `.cloudflare/`. The plan, its checks and the flags are the ones [Planning a deploy](#planning-a-deploy) and [Deploying with one command](#deploying-with-one-command) describe for the cf CLI. What differs on `wrangler.jsonc`:

- Preflight needs Wrangler 4.129 or later in the app, the Node version that Wrangler requires as the `node` on PATH, and a logged-in Wrangler (`bunx wrangler login`, or `CLOUDFLARE_API_TOKEN` in CI).
- The D1 database is looked up by its `database_name`. Migrations go to the binding whose `migrations_dir` is `.cloudflare/d1-migrations` (the scaffold's `DB`), as the flattened copy. A database whose `d1_migrations` holds nested names (`<folder>/migration.sql`) from a cf deploy is a `tracker-layout` blocker, since Wrangler would apply its whole history again.
- Only the top level of `wrangler.jsonc` is deployed, not its `env.<name>` blocks.
- The cleanup and rollback commands it prints are Wrangler's: `wrangler d1 delete`, `wrangler kv namespace delete`, `wrangler d1 time-travel restore` and `wrangler rollback`.

## Sessions and OAuth State Must Be Database-Backed

This is not a preference. Each request may land on a different isolate, and isolates share nothing but the database. The in-memory defaults will appear to work locally and then drop every session in production.

```typescript
// config/session.ts
import { defineSessionConfig } from '@guren/core'
import { sessions } from '../db/schema.js'

export default defineSessionConfig((env) => ({
  default: env.SESSION_DRIVER,
  stores: {
    database: { driver: 'database', table: sessions },
  },
}))
```

Declare `SESSION_DRIVER: Env.string().default('database')` in `config/env.ts`, so a deploy that sets nothing still gets the database store.

The same applies to OAuth: the authorize redirect and the callback that follows it routinely land on different isolates, so the state that ties them together has to be shared.

```typescript
// config/oauth.ts
import { DatabaseOAuthStateStore, defineOAuthConfig } from '@guren/core'
import { oauthStates } from '../db/schema.js'

export default defineOAuthConfig(() => ({
  // `providers` as in the OAuth guide
  stateStore: new DatabaseOAuthStateStore(oauthStates),
}))
```

List both definitions in `createApp()` beside the session middleware they back:

```typescript
// src/app.ts
import { createApp } from '@guren/core'
import database from '../config/database.js'
import env from '../config/env.js'
import oauth from '../config/oauth.js'
import session from '../config/session.js'
import { registerWebRoutes } from '../routes/web.js'

const app = createApp({
  env,
  config: [database, session, oauth],
  auth: {
    autoSession: true,
    sessionOptions: { cookieSecure: true },
  },
  routes: registerWebRoutes,
})
```

Apps that configure the session and OAuth state stores in a service provider keep working; see [Apps with service providers](./configuration.md#apps-with-service-providers).

Both stores need tables: `sessions` comes from `bunx guren add session`, and the `oauth_states` columns are in [State Storage](./oauth.md#state-storage). `bunx guren make:auth --oauth` generates both tables and wires both stores.

## Storage (R2)

Workers has no filesystem, so the `local` storage driver cannot run there. `R2Driver` puts a Cloudflare R2 bucket behind the same `StorageManager` API, through the bucket binding, with no credentials to provision and no AWS SDK in the bundle.

Create the bucket and bind it:

```bash
bunx wrangler r2 bucket create my-app-media
```

```jsonc
// wrangler.jsonc
"r2_buckets": [
  { "binding": "MEDIA", "bucket_name": "my-app-media" }
]
```

Then make `media` the default disk in `config/storage.ts`:

```typescript
// config/storage.ts
import { defineStorageConfig } from '@guren/core'

export default defineStorageConfig(() => ({ default: 'media' }))
```

A storage config can name only the built-in drivers (`local`, `s3`, `memory`), so register the disk itself on the bound manager from a provider's `register()`. It uses R2 on Workers and the local filesystem everywhere else, the same runtime switch `config/database.ts` uses for D1:

```typescript
// app/Providers/MediaDiskProvider.ts
import { ServiceProvider, LocalStorageDriver } from '@guren/core'
import { r2Disk } from '@guren/plugin-cloudflare'
import { isWorkersRuntime } from '@guren/plugin-cloudflare/env'

export default class MediaDiskProvider extends ServiceProvider {
  register(): void {
    const storage = this.container.make('storage')
    if (isWorkersRuntime()) {
      storage.registerDisk('media', ...r2Disk({ binding: 'MEDIA', publicUrl: 'https://media.example.com' }))
    } else {
      storage.registerDisk('media', () => new LocalStorageDriver({ root: './storage/app/public', url: '/storage' }))
    }
  }
}
```

List `storage` in `createApp({ config })` and `MediaDiskProvider` in `providers`.

`binding` names the binding, as for D1, and the driver reads it from the Workers env at its first operation. `r2Disk()` returns the factory together with a description of it, so the introspected app lists the disk as `{ driver: 'r2', binding: 'MEDIA' }` without building it. Every `storage.disk('media').put(...)` / `get(...)` / `files(...)` call from the [Storage guide](./storage.md) then works unchanged; `bun run dev` writes to disk, `wrangler dev` and production write to R2.

Three things follow from how R2 differs from S3:

- **`publicUrl` is required for `url()`.** Attach a custom domain to the bucket in the dashboard (the r2.dev subdomain is rate-limited and meant for development) and pass it as `publicUrl`; R2 has no derivable public URL, so `url()` throws without it.
- **`temporaryUrl()` needs S3 credentials.** The binding cannot sign URLs. Either pass `presign: { accountId, bucket, accessKeyId, secretAccessKey }` (an R2 API token), or keep private files behind an authenticated route in your app. Without `presign`, `temporaryUrl()` throws with that guidance.
- **Visibility is per bucket, not per object.** A bucket is public (custom domain / r2.dev) or private; there is no per-object ACL. The driver reports the bucket's `visibility` (defaults to `'public'` when `publicUrl` is set) and throws if `put({ visibility })` or `setVisibility()` asks for the other value, rather than pretending to honour it.

`putFile()` also throws, since there is no local file to read on Workers. Read the bytes yourself (`await file.arrayBuffer()`) and call `put()`. For one-off bulk loads, `bunx wrangler r2 object put my-app-media/<key> --file <path>` from your machine is simpler than going through the app.

To reach the same bucket from a Bun process (a script, or a non-Workers deployment), use the S3-compatible endpoint with the S3 driver instead: `endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com'`, `region: 'auto'`, and an R2 API token, as shown in the [Storage guide](./storage.md#s3-compatible-services).

### Attachments on Workers

The [attachments layer](./attachments.md) works on Workers with one split: Workers has no image decoder, so image work happens in a queue worker instead of the request path.

- **The synchronous gates still run in the Worker.** Oversized bytes (413), header dimensions over `maxPixels` (422), the HEIC signature (415), and non-image bytes on an `image: 'require'` collection (422) are all rejected in the request: they are pure JavaScript, no decoder involved.
- **Attach with `queued: true`.** The Worker stores the original, seeds declared variants as `pending`, and dispatches `GenerateVariantsJob` on the Redis-backed queue (`RedisQueueDriver`, the same store the queue guide already requires on Workers). Variant URLs fall back to the original until the job completes.
- **Run the worker on Bun.** A separate Bun process (`Bun.Image` present) processes the queue: it runs the deferred full decode, converts HEIC where the collection opted in, and generates the variants. `configureAttachments()` registers the job, so any worker that boots the app's config can process it with no extra wiring.
- **Private attachments work on the binding alone via the signed delivery route.** Declare the disk private and enable the route in `configureAttachments()`: `disks: { media: 'private' }, delivery: {}`. Undeclared disks default to **public**, and a bucket configured with `publicUrl` is public by default too. Then mount `registerAttachmentRoutes(router)` in your route registrar: private attachments get path-relative signed URLs, and the route streams `get().body` through the Worker with no `presign` credentials. With `presign` configured, the driver declares `capabilities.presignedGet` and the same route upgrades to a 302 redirect to a short-lived presigned URL. One R2 caveat: its S3 API ignores the `response-content-*` header overrides, so a redirect serves the object's stored metadata. An app that must force `Content-Disposition: attachment` on a presign-capable R2 disk uses `serve: 'proxy'`. Public attachments are unchanged: they serve from the bucket's custom domain with zero Worker CPU.

The one class the synchronous gates cannot catch — bytes whose header lies — is detected by the worker after acceptance: on an `image: 'require'` collection the job purges the attachment; elsewhere the bytes stay as an opaque file.

## Secrets

`APP_KEY` is required: sessions and CSRF are signed with it, and the worker throws during startup without it, before serving a single request.

```bash
bun -e "console.log('base64:'+Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))" | bunx wrangler secret put APP_KEY
```

Add any others your app reads (OAuth credentials, API keys) the same way, and declare each in `config/env.ts`. Vars and secrets arrive on the worker entrypoint's `env` rather than reliably on `process.env`; `@guren/plugin-cloudflare` binds that `env` before the app boots, and the schema reads from it, so app code reads the validated values as it does locally ([Configuration](./configuration.md#cloudflare-workers)). Only non-sensitive values belong in the `vars` block of `wrangler.jsonc`.

## Free Plan Limits

Two limits shape what an app can do:

| Limit | Value | What it means |
|---|---|---|
| Worker size | 64 MiB uncompressed, every plan | Generated content belongs in Static Assets, KV or R2, not in the bundle |
| CPU per request | 10 ms | Anything expensive belongs at build time or save time |

Cloudflare removed the compressed size limits (3 MB Free, 10 MB Paid) on 2026-09-04; only the uncompressed bundle counts now. Measure yours with `bunx guren cloudflare:size` (or `cloudflare:build --report-size`): it runs wrangler's dry run and lists the largest sources by package, which is where a bundle that grew unnoticed shows up. Two limits the number does not cover: startup time (1 s, `wrangler check startup`) and memory (128 MB per isolate), both of which large bundled data also eats.

The CPU budget rules out password hashing entirely: a deliberately slow operation cannot fit in 10 ms. Apps on the free plan should authenticate through OAuth rather than passwords. See [Authentication](./authentication.md) for the OAuth flow.

The same budget rewards moving work off the request path: render Markdown when content is saved rather than when it is read, and prerender static content at build time. The paid plan lifts the CPU limit if your workload genuinely needs it.

## Observability

Workers keeps no logs by default, which makes a production failure very hard to trace:

```jsonc
{
  "observability": {
    "enabled": true
  }
}
```

Pair it with `bunx wrangler tail` for live output while reproducing an issue.

## Local Development

`wrangler dev` runs the real runtime against a local D1 database, and is worth using before deploying, since it catches runtime differences that a Bun dev server cannot:

```bash
bunx wrangler d1 migrations apply my-app --local
bunx wrangler dev
```

Put local secrets in `.dev.vars` (and add it to `.gitignore`):

```
APP_KEY=base64:...
```

Your normal `bun run dev` server is still the faster loop for day-to-day work. Reach for `wrangler dev` when you are about to deploy, or when something behaves differently in production.

## Static Assets

Everything under `public/` is staged into `.cloudflare/assets/` and served by Workers Static Assets, which answers **before** the worker runs. Two consequences the build handles for you:

- It writes a `_headers` file alongside the staged files, giving the types a browser renders as a document (`.html`, `.htm`, `.svg`, `.xhtml`, `.xml`) `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. This is the same policy the framework applies to `public/` locally, which the worker never gets the chance to apply here. Images, scripts, stylesheets and fonts are untouched. A `_headers` of your own under `public/` is kept, with the generated rules placed ahead of it; the platform reads at most 100 rules and stops there rather than reporting the rest, so the build warns when the two together cross that line. Matching is case-sensitive, which a glob cannot work around (one splat per rule), so a file staged as `Logo.SVG` gets an exact rule of its own instead. An app that spells its extensions in lowercase gets no extra rules.
- It sets `"html_handling": "none"` on the `assets` binding, so a staged `page.html` is served at `/page.html` and nowhere else. Under the platform default it would also answer at `/page`, which both shadows any route of that name in your app and moves the file off the path the `_headers` rule matches. Requests that no staged file answers fall through to the worker, which is where your pages come from.

If your app deliberately serves pretty-URL HTML out of `public/`, set `"html_handling"` yourself in `wrangler.jsonc`; the build leaves any value you name alone, and the `.html` rule is weaker for it.

## Translations

Workers has no filesystem to read `lang/` from, so the build bakes every `lang/<locale>/*.json` into the worker and `createApp({ i18n })` serves them from there. Edit the JSON files as usual and rebuild. An app that sets the i18n `path` option is not covered; see [Serverless and Bundled Catalogs](./i18n.md#serverless-and-bundled-catalogs).

## Scheduled Tasks

The generated worker exports a `scheduled` handler alongside `fetch`, so a Cloudflare cron trigger runs the tasks your app registered with `createScheduler()`. There is no long-lived process on Workers to hold a ticking scheduler, and `scheduler.start()` never runs there: the trigger is what advances the clock.

Two things you supply. First, the tasks and a provider binding the scheduler, exactly as on a Bun server. Declaring them in `app/Console/Kernel.ts` is what also lets `guren schedule:list` and `guren schedule:run` see them. The file is the requirement, in either shape those commands accept ([Making tasks visible to the CLI](./scheduling.md#making-tasks-visible-to-the-cli)):

```ts
// app/Console/Kernel.ts
import { Schedule, defaultContainer, type SessionManager } from '@guren/core'

export function scheduleTasksKernel(): Schedule {
  const schedule = new Schedule()

  // Resolved when the task runs, not when the kernel is built: the `session`
  // binding is made by app.boot(), which the cron entrypoint awaits first.
  schedule
    .call(() => defaultContainer().make<SessionManager>('session').pruneExpired())
    .hourly()
    .name('sessions:prune')

  return schedule
}
```

```ts
// app/Providers/SchedulingProvider.ts
import { ServiceProvider, createScheduler } from '@guren/core'
import { scheduleTasksKernel } from '../Console/Kernel.js'

export default class SchedulingProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('scheduler', () => {
      // Without a logger, a task that throws is caught and discarded — see below.
      const scheduler = createScheduler({ logger: console.log })
      for (const task of scheduleTasksKernel().buildTasks()) {
        scheduler.addTask(task)
      }
      return scheduler
    })
  }
}
```

Second, the trigger itself in `wrangler.jsonc`. The build does not scaffold one, since a trigger fires and bills whether or not the app has tasks:

```jsonc
{
  "triggers": { "crons": ["* * * * *"] }
}
```

Each firing runs whichever tasks are due at that minute, so **a trigger coarser than your finest task means that task never runs**: a `["0 * * * *"]` trigger and a task at `.dailyAt('03:30')` never meet. Match the trigger to the finest granularity you schedule, or schedule only on the trigger's own boundaries.

Constraints particular to Workers:

- **`schedule.command()` does not work.** It shells out through `node:child_process`, which Workers has no subprocess to run. It fails when the task runs, not at build time. Use `schedule.call()` or `schedule.job()` and call the work directly. The example above is what `sessions:prune` looks like in-process.
- **A trigger that finds no `scheduler` binding throws**, rather than reporting a successful sweep of nothing. The error names the fix and lands in `wrangler tail` like any other worker exception.
- **A task that throws does not.** `runDueTasks()` catches per task and reports through the scheduler's `logger`, which defaults to a no-op, so a sweep failing on a D1 error would report success with nothing in `wrangler tail`. Pass a `logger` when you create the scheduler.
- **`preventOverlapping()` does not carry across firings.** It is an in-memory flag on the task, and every invocation may get a fresh isolate, so a task slower than the trigger interval overlaps itself. Keep tasks shorter than the interval, or hold the guard somewhere that outlives the isolate: a row in D1, or a Durable Object, which has durable per-instance state and its own alarm-backed schedules ([Durable Agents](./durable-agents.md)). A cron trigger is the right shape for an app-wide sweep with no identity; a job that must not overlap itself has an identity, and that is what a Durable Object addresses.
- **`runOnOneServer()` needs a `SchedulerLock` the isolates share.** The default `MemorySchedulerLock` lives in one isolate and so guards nothing here; the scheduler warns and runs the task on every firing. Workers has no Redis, and KV has no conditional write, so implement `SchedulerLock` over a D1 insert on a unique key, or a Durable Object, and pass it as `createScheduler({ lock })`.

An `--mcp-oauth` worker sweeps one thing more. Before your tasks run, each firing checks whether an hour has passed since its last sweep and, if so, calls the OAuth provider's `purgeExpiredData`: the only thing that removes a grant orphaned by a deleted client, which carries no expiry for KV's own TTLs to act on. One sweep checks up to 15 grants and, in a second call, up to 15 tokens. They are separate calls because the provider stops as soon as the grant pass fills its budget and would never reach the tokens behind it. Both start from the head of the key space: the provider's cursor does not survive a call, so records past that window are never reached, and a capped sweep says so in `wrangler tail`. The window is that shallow because a Free-plan invocation allows 50 subrequests, KV reads count, and your own tasks share the same budget. A worker cannot tell which plan it is on. A sweep that fails is logged, marks itself done for the interval, and does not stop your tasks.

The sweep needs a `triggers.crons` entry like anything else here. An app that adds one only for the sweep still has to bind a `scheduler`, or every firing sweeps and then throws on the empty binding above.

## Durable Agents

Workers is also the substrate for agents your application hosts itself: Durable Objects give a long-lived agent durable identity, durable state and alarm-backed schedules. `@guren/plugin-agents` puts them behind the same agent tools your routes already declare.

When the app has a `config/agents.ts`, `cloudflare:build` does three extra things: it appends a named export per registered class to the generated worker, it verifies that the committed `wrangler.jsonc` hosts each one as a SQLite-backed Durable Object (failing with the exact JSON to add rather than deploying an agent with no binding), and it mounts `/agents/*` deny-all behind the registry's own authorizer. Do not hand-write the `durable_objects` and `migrations` entries; run the build and paste what it prints.

The Free-plan measurements for a deployed agent, the D1 query budget a sweep has to fit in, and everything else about writing one are in [Durable Agents](./durable-agents.md).

## Deploying with the cf CLI (beta)

`cf` is Cloudflare's successor to Wrangler, in open beta. It reads `cloudflare.config.ts` instead of `wrangler.jsonc`, and `cloudflare:build` switches to it when the app has a `cloudflare.config.ts` and declares the `cf` package. Without that file, nothing changes.

The deploy machine needs Node 22.18 or later, because `cf` loads `cloudflare.config.ts` with Node, and Wrangler 4.136 or later, which `cf` hands the bundling to:

```bash
bun add -d cf wrangler
```

`bunx guren cloudflare:init` writes the three files this path reads: `cloudflare.config.ts`, `wrangler.config.ts` and `config/cloudflare.ts` (below), and adds `.cloudflare/` to `.gitignore`. On an app that already has a `wrangler.jsonc`, it carries over the Worker name, the compatibility date, the `DB` database name and the `OAUTH_KV` namespace (by id, in `cloudflare.config.ts`), so the first `cf` deploy binds what Wrangler did, and it names every other setting cf would no longer read (routes, vars, other bindings) for you to add after the spread. A file that exists is left as it is unless you pass `--force`. An app whose `wrangler.jsonc` hosts Durable Objects gets a warning: whether a deployed class keeps its storage when its declaration moves from `migrations` to `exports` is not yet confirmed, so try the move on a staging Worker first.

```bash
bunx guren cloudflare:init
```

`gurenWorker()` returns the worker `cloudflare:build` assembled: its entry, the `DB` binding by name, `OAUTH_KV` under `--mcp-oauth`, and each agent as a SQLite-backed Durable Object. Your own settings go in the same object, after the spread:

```typescript
// cloudflare.config.ts
import { bindings, defineConfig } from 'cf/config'
import { gurenWorker } from '@guren/plugin-cloudflare/config'

export default defineConfig(async () => {
  const worker = await gurenWorker({ name: 'my-app' })
  return {
    worker: {
      ...worker,
      compatibilityDate: '2026-10-01',
      env: { ...worker.env, MEDIA: bindings.r2({}) },
    },
  }
})
```

```typescript
// wrangler.config.ts
import { defineWranglerConfig } from 'wrangler/experimental-config'
import { gurenWranglerBundle } from '@guren/plugin-cloudflare/config'

export default defineWranglerConfig(gurenWranglerBundle())
```

`compatibilityDate` is yours to set and to move. `gurenWranglerBundle()` supplies the module stubs, the build-time `define` entries and the assets directory, with `keepNames` on. It also adds one `* * * * *` cron trigger when the schedule kernel registers tasks; a `triggers` key you write after the spread replaces it. Tasks registered anywhere other than the kernel, and the `--mcp-oauth` storage sweep on its own, need that key. A kernel the build cannot load adds no trigger, and `cloudflare:deploy` then stops rather than deploy without one, until the kernel loads or the config sets `triggers`.

Guren's own deploy settings go in `config/cloudflare.ts`. The build and `cloudflare:deploy` read it, the running app never does, and `guren check` does not ask for it in `createApp({ config })`:

```typescript
// config/cloudflare.ts
import { defineCloudflareConfig } from '@guren/plugin-cloudflare/config'

export default defineCloudflareConfig({
  mcpOAuth: true,
  resourceNames: { OAUTH_KV: 'my-app-oauth' },
})
```

- `mcpOAuth` and `mcpPath` replace the `--mcp-oauth` and `--mcp-path` flags on this path. A flag the file contradicts is refused, and a flag the file does not set is used with a warning, since nothing records it for the next build.
- `resourceNames` names a binding's resource when the default (`<worker>` for `DB`, `<worker>-<binding>` for the rest) collides with another project's or breaks a naming limit. A KV binding cannot carry its name in `cloudflare.config.ts`, so a plain `cf deploy` would still pick the default; deploy through `cloudflare:deploy` once you set one.

Build, then deploy from the app root:

```bash
bunx guren cloudflare:build
bunx cf deploy
```

On this path the build assembles into `.guren/cloudflare/` and writes `guren-worker.json` there for `gurenWorker()` to read. The directory carries its own `.gitignore`, and `cf`'s files under `.cloudflare/` are left alone. The bindings carry no ids, so `cf deploy` creates the database and namespaces on the first deploy, by the same name lookup as [Wrangler](#database-d1).

`cf d1 migrations apply` takes the database id rather than its name. Look it up with `bunx cf d1 list --name my-app`, then apply the flattened migrations the build wrote (remote is the default; `--local` targets the local simulation):

```bash
bunx cf d1 migrations apply <database-id> --dir .guren/cloudflare/d1-migrations
```

That directory records each migration under the same name as `wrangler d1 migrations apply`, so a database migrated through Wrangler keeps its history. `cloudflare:size` measures only the Wrangler path.

### Planning a deploy

`bunx guren cloudflare:deploy --plan` checks the tools, builds, runs `cf build`, and resolves each D1 and KV binding against the account, without writing anything there:

```bash
bunx guren cloudflare:deploy --plan
```

Each binding is listed as `existing` (the resource a previous run settled, or an id you wrote), `adopt` (found under the planned name but not yet settled, so check it belongs to this app), or `create on deploy`. The KV name is `<worker>-<binding>` with `_` written as `-`, the name `cf deploy` itself creates. The command exits 1 on a blocker:

- `binding-conflict`: an id in `cloudflare.config.ts` and the planned name point at different resources, or two resources share the name.
- `resource-missing`: an id you wrote is not in the account, or a resource is missing and the run may not create it. A run with `--ci`, or without a terminal, creates nothing unless `--provision` is passed.
- `source-unreadable`: `cf` could not list the account's resources, query the migrations tracker, or the app's `config/env.ts` would not load. The plan stops rather than guess.
- `tracker-layout`: the database's `d1_migrations` records both flattened names (`<folder>.sql`) and nested ones (`<folder>/migration.sql`).
- `destructive-migration`: a pending migration drops or narrows something without a `-- guren:allow-destructive` comment ([Destructive migrations](./database.md#destructive-migrations)). `--allow-destructive` lists them as a warning instead.
- `secrets`: a variable `config/env.ts` requires in production has no value on the deployed Worker, in the config, or in `--secrets-file`.

The plan reads which migrations the database has applied, picks the layout its tracker already uses, and prints the `cf d1 migrations apply` arguments for it. A database Wrangler migrated stays on the flattened copy, so nothing is applied twice. A database the deploy will create has applied nothing, so every local migration is judged. For secrets, a first deploy has no Worker to read from, so list the values in a dotenv file and pass it as `--secrets-file .env.production`. The plan reads only the names in it.

Preflight needs Node 22.18 or later as the `node` on PATH, Wrangler 4.136 or later in the app, and a logged-in `cf` (`bunx cf auth login`, or `CLOUDFLARE_API_TOKEN` in CI). `--json` prints `{ plan }` as one object.

### Deploying with one command

Without `--plan`, the same command goes on to deploy:

```bash
bunx guren cloudflare:deploy --secrets-file .env.production
```

After showing the plan it asks once, and writes nothing to the account until you answer yes. A plan with a blocker stops there instead. Then it:

1. creates each resource marked `create on deploy`, and records every resolved id in `guren-worker.json` (inside the ignored output directory, never in the repository);
2. runs `cf build` again when an id changed, and stops if `cloudflare.config.ts` binds a resource other than the one recorded;
3. records a D1 Time Travel bookmark, lists the pending migrations again, and applies them only if they are still the set the plan judged;
4. runs `cf deploy --prebuilt --no-provision`, so a resource missing at this point fails the deploy instead of being created unplanned;
5. prints the URL, what it created and migrated, and how to roll back. A rollback does not revert migrations.

Nothing is ever deleted. If a step fails after something was written, the report lists the `cf d1 delete` / `cf kv namespaces delete` commands for what this run created and, after a migration, the `cf d1 time-travel restore` command for the bookmark. Run them yourself if you want them.

`bunx guren deploy --target cloudflare` writes a GitHub Actions workflow that does this on every push to main. In CI there is no one to answer, so pass `--yes` to deploy, or `--ci` to deploy only when nothing needs creating (`--ci --provision` allows creation). `--skip-migrations` deploys without applying. Run deploys of one Worker one at a time, for example with a GitHub Actions `concurrency` group per Worker: two runs at once can create the same resource or apply the same migration.

## Upgrading an Existing App

`wrangler.jsonc` is scaffolded once and never overwritten, so an app created before a plugin update keeps its original config. The build prints exactly which entries are missing when it finds an outdated one. Add them and rebuild.

The build also names any placeholder id left in `d1_databases` or `kv_namespaces`, such as the `TODO:` values an older scaffold wrote, in every `env.<name>` block too. Delete the key, or replace it with the real id; see [Database (D1)](#database-d1).

`triggers.crons` is the one entry it does not print. Whether an app registers scheduled tasks is only visible to a build that can find and load its schedule kernel, and a task declared any other way would read as absent, so the build stays quiet rather than guessing. An app that has tasks and wants them to run on Workers adds the trigger by hand; see [Scheduled Tasks](#scheduled-tasks).

## Post-Deployment

- Point a custom domain at the worker in the Cloudflare dashboard, then update any OAuth callback URLs to match.
- Follow the [Production Operations Runbook](./operations.md) for monitoring and incident response.

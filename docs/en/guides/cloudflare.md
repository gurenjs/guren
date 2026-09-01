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
> `.cloudflare/` is generated output — add it to `.gitignore` and rebuild before every deploy. Nothing else reads from it, so a stale directory silently ships old code.

## Database (D1)

Create the database and record its id in `wrangler.jsonc`:

```bash
bunx wrangler d1 create my-app
```

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app",
      "database_id": "<the id wrangler printed>",
      "migrations_dir": ".cloudflare/d1-migrations"
    }
  ]
}
```

Select the driver by runtime in `config/database.ts`. D1 speaks SQLite, so write your schema in the SQLite dialect and keep a local SQLite file for development:

```typescript
import { createD1Database, createSqliteDatabase } from '@guren/core'
import { getWorkersEnv } from '@guren/plugin-cloudflare'

interface WorkersEnv {
  DB: unknown
}

export function isWorkersRuntime(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'
}

const database = isWorkersRuntime()
  ? createD1Database({ binding: () => getWorkersEnv<WorkersEnv>().DB })
  : createSqliteDatabase({
      migrationsFolder: new URL('../db/migrations', import.meta.url),
      filename: () => process.env.SQLITE_DATABASE_PATH ?? './data/guren.db',
    })

export const { getDatabase, configureOrm, seedDatabase } = database
```

The binding is a resolver, not a value: bindings only exist once a request arrives, so it must be read lazily.

### Applying migrations

Migrations are applied out of band — the app never migrates itself on Workers:

```bash
bunx guren cloudflare:build          # regenerates .cloudflare/d1-migrations
bunx wrangler d1 migrations apply my-app --remote
```

> [!WARNING]
> Build first. `migrations_dir` points inside the generated directory, and `wrangler` reports "no migrations to apply" — successfully, with no error — when it finds an empty folder. Applying before building is the one failure here that looks like success.

Skip the filesystem probe when bootstrapping models, since there is no filesystem to probe:

```typescript
export async function bootModels(): Promise<void> {
  await configureOrm()
  if (!isWorkersRuntime()) {
    await seedDatabase()
  }
}
```

## Sessions and OAuth State Must Be Database-Backed

This is not a preference. Each request may land on a different isolate, and isolates share nothing but the database. The in-memory defaults will appear to work locally and then drop every session in production.

```typescript
import { createApp, AuthServiceProvider, DatabaseSessionStore } from '@guren/core'
import { sessions } from '../db/schema.js'

const app = createApp({
  providers: [AuthServiceProvider],
  auth: {
    autoSession: true,
    sessionOptions: {
      store: new DatabaseSessionStore(sessions),
      cookieSecure: true,
    },
  },
})
```

The same applies to OAuth: the authorize redirect and the callback that follows it routinely land on different isolates, so the state that ties them together has to be shared.

```typescript
import { createOAuthManager, DatabaseOAuthStateStore } from '@guren/core'
import { oauthStates } from '../db/schema.js'

const oauth = createOAuthManager({
  stateStore: new DatabaseOAuthStateStore(oauthStates),
})
```

Both stores need tables. See [Authentication](./authentication.md) for the schema.

## Storage (R2)

Workers has no filesystem, so the `local` storage driver cannot run there. `R2Driver` puts a Cloudflare R2 bucket behind the same `StorageManager` API, through the bucket binding — no credentials to provision and no AWS SDK in the bundle.

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

Then register a disk that uses R2 on Workers and the local filesystem everywhere else, the same runtime switch `config/database.ts` uses for D1:

```typescript
// app/Providers/StorageProvider.ts
import { ServiceProvider, createStorageManager, LocalStorageDriver } from '@guren/core'
import { R2Driver, getWorkersEnv } from '@guren/plugin-cloudflare'
import { isWorkersRuntime } from '../../config/database.js'

interface Env {
  MEDIA: unknown
}

export default class StorageProvider extends ServiceProvider {
  register(): void {
    const storage = createStorageManager({ default: 'media' })
    storage.registerDisk('media', () =>
      isWorkersRuntime()
        ? new R2Driver({
            binding: () => getWorkersEnv<Env>().MEDIA,
            publicUrl: 'https://media.example.com',
          })
        : new LocalStorageDriver({ root: './storage/app/public', url: '/storage' }),
    )
    this.container.instance('storage', storage)
  }
}
```

`binding` is a resolver, not a value — bindings arrive with the first request, so it must be read lazily, exactly like the D1 binding. Every `storage.disk('media').put(...)` / `get(...)` / `files(...)` call from the [Storage guide](./storage.md) then works unchanged; `bun run dev` writes to disk, `wrangler dev` and production write to R2.

Three things follow from how R2 differs from S3:

- **`publicUrl` is required for `url()`.** Attach a custom domain to the bucket in the dashboard (the r2.dev subdomain is rate-limited and meant for development) and pass it as `publicUrl`; R2 has no derivable public URL, so `url()` throws without it.
- **`temporaryUrl()` needs S3 credentials.** The binding cannot sign URLs. Either pass `presign: { accountId, bucket, accessKeyId, secretAccessKey }` (an R2 API token), or keep private files behind an authenticated route in your app. Without `presign`, `temporaryUrl()` throws with that guidance.
- **Visibility is per bucket, not per object.** A bucket is public (custom domain / r2.dev) or private; there is no per-object ACL. The driver reports the bucket's `visibility` (defaults to `'public'` when `publicUrl` is set) and throws if `put({ visibility })` or `setVisibility()` asks for the other value, rather than pretending to honour it.

`putFile()` also throws — there is no local file to read on Workers. Read the bytes yourself (`await file.arrayBuffer()`) and call `put()`. For one-off bulk loads, `bunx wrangler r2 object put my-app-media/<key> --file <path>` from your machine is simpler than going through the app.

To reach the same bucket from a Bun process — a script, or a non-Workers deployment — use the S3-compatible endpoint with the S3 driver instead: `endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com'`, `region: 'auto'`, and an R2 API token, as shown in the [Storage guide](./storage.md#s3-compatible-services).

### Attachments on Workers

The [attachments layer](./attachments.md) works on Workers with one split: Workers has no image decoder, so image work happens in a queue worker instead of the request path.

- **The synchronous gates still run in the Worker.** Oversized bytes (413), header dimensions over `maxPixels` (422), the HEIC signature (415), and non-image bytes on an `image: 'require'` collection (422) are all rejected in the request — they are pure JavaScript, no decoder involved.
- **Attach with `queued: true`.** The Worker stores the original, seeds declared variants as `pending`, and dispatches `GenerateVariantsJob` on the Redis-backed queue (`RedisQueueDriver` — the same store the queue guide already requires on Workers). Variant URLs fall back to the original until the job completes.
- **Run the worker on Bun.** A separate Bun process (`Bun.Image` present) processes the queue: it runs the deferred full decode, converts HEIC where the collection opted in, and generates the variants. `configureAttachments()` registers the job, so any worker that boots the app's config can process it — no extra wiring.
- **Private attachments work on the binding alone via the signed delivery route.** Declare the disk private and enable the route in `configureAttachments()` — `disks: { media: 'private' }, delivery: {}` (undeclared disks default to **public**, and a bucket configured with `publicUrl` is public by default too) — and mount `registerAttachmentRoutes(router)` in your route registrar: private attachments get path-relative signed URLs, and the route streams `get().body` through the Worker with no `presign` credentials. With `presign` configured, the driver declares `capabilities.presignedGet` and the same route upgrades to a 302 redirect to a short-lived presigned URL. One R2 caveat: its S3 API ignores the `response-content-*` header overrides, so a redirect serves the object's stored metadata — an app that must force `Content-Disposition: attachment` on a presign-capable R2 disk uses `serve: 'proxy'`. Public attachments are unchanged: they serve from the bucket's custom domain with zero Worker CPU.

The one class the synchronous gates cannot catch — bytes whose header lies — is detected by the worker after acceptance: on an `image: 'require'` collection the job purges the attachment; elsewhere the bytes stay as an opaque file.

## Secrets

`APP_KEY` is required — sessions and CSRF are signed with it, and the worker throws during startup without it, before serving a single request.

```bash
bun -e "console.log('base64:'+Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))" | bunx wrangler secret put APP_KEY
```

Add any others your app reads (OAuth credentials, API keys) the same way. Secrets set through `wrangler secret put` are available as `process.env.*` at runtime; only non-sensitive values belong in the `vars` block of `wrangler.jsonc`.

## Free Plan Limits

Two limits shape what an app can do:

| Limit | Value | What it means |
|---|---|---|
| Worker size | 3 MB gzipped | Large generated content must be weighed against the budget |
| CPU per request | 10 ms | Anything expensive belongs at build time or save time |

The CPU budget rules out password hashing entirely — a deliberately slow operation cannot fit in 10 ms. Apps on the free plan should authenticate through OAuth rather than passwords. See [Authentication](./authentication.md) for the OAuth flow.

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

`wrangler dev` runs the real runtime against a local D1 database — worth using before deploying, since it catches runtime differences that a Bun dev server cannot:

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

- It writes a `_headers` file alongside the staged files, giving the types a browser renders as a document — `.html`, `.htm`, `.svg`, `.xhtml`, `.xml` — `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. This is the same policy the framework applies to `public/` locally, which the worker never gets the chance to apply here. Images, scripts, stylesheets and fonts are untouched. A `_headers` of your own under `public/` is kept, with the generated rules placed ahead of it.
- It sets `"html_handling": "none"` on the `assets` binding, so a staged `page.html` is served at `/page.html` and nowhere else. Under the platform default it would also answer at `/page` — which both shadows any route of that name in your app and moves the file off the path the `_headers` rule matches. Requests that no staged file answers fall through to the worker, which is where your pages come from.

If your app deliberately serves pretty-URL HTML out of `public/`, set `"html_handling"` yourself in `wrangler.jsonc`; the build leaves any value you name alone, and the `.html` rule is weaker for it.

## Upgrading an Existing App

`wrangler.jsonc` is scaffolded once and never overwritten, so an app created before a plugin update keeps its original config. The build prints exactly which entries are missing when it finds an outdated one — add them and rebuild.

## Post-Deployment

- Point a custom domain at the worker in the Cloudflare dashboard, then update any OAuth callback URLs to match.
- Follow the [Production Operations Runbook](./operations.md) for monitoring and incident response.

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

function isWorkersRuntime(): boolean {
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

## Upgrading an Existing App

`wrangler.jsonc` is scaffolded once and never overwritten, so an app created before a plugin update keeps its original config. The build prints exactly which entries are missing when it finds an outdated one — add them and rebuild.

## Post-Deployment

- Point a custom domain at the worker in the Cloudflare dashboard, then update any OAuth callback URLs to match.
- Follow the [Production Operations Runbook](./operations.md) for monitoring and incident response.

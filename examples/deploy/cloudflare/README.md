# Deploy to Cloudflare Workers

This recipe deploys a Guren application to [Cloudflare Workers](https://workers.cloudflare.com) with [D1](https://developers.cloudflare.com/d1/) as the database, using `@guren/plugin-cloudflare`.

The site you are reading this on runs exactly this way.

## Prerequisites

- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) installed, and `wrangler login` completed
- A Cloudflare account
- An app whose schema is written in the SQLite dialect (D1 speaks SQLite)

## Steps

### 1. Install the plugin

```bash
bunx guren plugin @guren/plugin-cloudflare
bun add @guren/plugin-cloudflare
```

Copy the `wrangler.jsonc` here as a starting point, or let the first build scaffold one.

### 2. Create the database

```bash
bunx wrangler d1 create my-guren-app
```

Paste the printed id into `d1_databases[0].database_id`.

### 3. Wire the build

Two steps have to run in order, so put them behind one script:

```json
{
  "scripts": {
    "cloudflare:build": "bun run build && bunx guren cloudflare:build --skip-app-build",
    "deploy:cloudflare": "bun run cloudflare:build && bunx wrangler deploy"
  }
}
```

Add `.cloudflare/` to `.gitignore` — it is generated output, rebuilt on every deploy.

### 4. Set secrets

`APP_KEY` is required; the worker throws on startup without it, before serving a single request:

```bash
bun -e "console.log('base64:'+Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))" | bunx wrangler secret put APP_KEY
```

### 5. Apply migrations, then deploy

```bash
bun run cloudflare:build
bunx wrangler d1 migrations apply my-guren-app --remote
bunx wrangler deploy
```

> [!WARNING]
> Build before applying migrations. `migrations_dir` points inside the generated directory, and wrangler reports "no migrations to apply" — successfully, with no error — when it finds an empty folder.

### 6. Point a domain at it

Uncomment the `routes` block in `wrangler.jsonc` and deploy again. Cloudflare must already be authoritative for the zone, and **any existing DNS record for that hostname has to be deleted first** — otherwise the deploy cannot claim it, and the old host keeps answering as if nothing changed.

## What Must Be Different on Workers

| Concern | Why |
|---|---|
| Sessions and OAuth state in the database | Requests land on different isolates, which share nothing else. In-memory stores work locally and drop every session in production. |
| No password hashing on the free plan | The CPU budget is 10 ms per request; a deliberately slow hash cannot fit. Authenticate through OAuth instead. |
| Work moved off the request path | Same budget — render Markdown at save time, prerender static content at build time. |
| Migrations applied out of band | There is no filesystem for the app to migrate itself from. |

## Local Development

```bash
bunx wrangler d1 migrations apply my-guren-app --local
bunx wrangler dev
```

`wrangler dev` runs the real runtime, so it catches differences a Bun dev server cannot. Put local secrets in `.dev.vars`.

When testing hostname-dependent behaviour, use `wrangler dev --host <hostname>` — spoofing a `Host` header does not change the URL the worker sees, which makes such code look broken when it is fine.

For the full reference, including free-plan limits and observability, see the [Cloudflare Workers Deployment Guide](../../../docs/en/guides/cloudflare.md).

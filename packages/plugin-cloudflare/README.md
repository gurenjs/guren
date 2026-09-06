# @guren/plugin-cloudflare

Deploy a [Guren](https://guren.dev/) application to Cloudflare Workers, with D1 as the database.

```bash
bunx guren plugin @guren/plugin-cloudflare
bun add @guren/plugin-cloudflare
```

Installing registers a `cloudflare:build` command and scaffolds `wrangler.jsonc` on the first build.

## Build and deploy

```bash
bunx guren cloudflare:build
bunx wrangler deploy
```

`cloudflare:build` runs your app's `build` script, then assembles a `.cloudflare/` directory containing the worker entry, static assets for Workers Static Assets, and flattened D1 migrations. It is generated output — add it to `.gitignore` and rebuild before every deploy.

## API

- **`createWorkersHandler(app)`** — wraps a Guren `Application` in a Workers module handler. Boot is lazy and deduplicated on the first request, because `boot()` performs I/O that workerd forbids in global scope. The handler deduplicates boot itself, so boot-once holds for anything matching `WorkersAppLike`, not only Guren's `Application`. It also exposes `boot(env)`, for an entrypoint that holds `env` but no request — an agent Durable Object woken by an alarm. The latch behind both is `bootWorkersApp(app, env)` / `bootAndFetch(app, request, env, ctx)`, keyed on the app.
- **Durable agents** — when the app has a `config/agents.ts` (see `@guren/plugin-agents`), `cloudflare:build` appends a named export per registered class to the generated worker, verifies the committed `wrangler.jsonc` hosts each one as a SQLite-backed Durable Object (failing with the exact JSON to add), and mounts `/agents/*` deny-all behind the registry's `routing.authorize`.
- **`getWorkersEnv<Env>()`** and **`isWorkersRuntime()`** — from `@guren/plugin-cloudflare/env`, an import-free subpath, so `config/*.ts` does not drag the deploy generator into every boot. `getWorkersEnv` exposes the first request's bindings to boot-time config through a write-once holder; `isWorkersRuntime()` is the workerd check the snippets below branch on. workerd can also expose bindings at module scope via `cloudflare:workers`, but importing that from shared config would break every other runtime (Bun, Lambda, Vercel) — the holder keeps `config/*.ts` portable. Use it to hand a D1 binding to the ORM:

  ```typescript
  import { createD1Database } from '@guren/core'
  import { getWorkersEnv } from '@guren/plugin-cloudflare/env'

  const database = createD1Database({
    binding: () => getWorkersEnv<{ DB: unknown }>().DB,
  })
  ```

  The binding is a resolver, not a value — it must be read lazily.

- **`R2Driver`** — a storage driver over the R2 bucket binding, for `StorageManager.registerDisk()`. Same lazy `binding` contract as D1; no credentials and no AWS SDK in the bundle:

  ```typescript
  import { createStorageManager, LocalStorageDriver } from '@guren/core'
  import { getWorkersEnv, isWorkersRuntime } from '@guren/plugin-cloudflare/env'
  import { R2Driver } from '@guren/plugin-cloudflare'

  const storage = createStorageManager({ default: 'media' })
  storage.registerDisk('media', () =>
    isWorkersRuntime()
      ? new R2Driver({ binding: () => getWorkersEnv<{ MEDIA: unknown }>().MEDIA, publicUrl: 'https://media.example.com' })
      : new LocalStorageDriver({ root: './storage/app/public', url: '/storage' }),
  )
  ```

  with `"r2_buckets": [{ "binding": "MEDIA", "bucket_name": "my-app-media" }]` in `wrangler.jsonc`. Three methods differ from the S3 driver, because the binding differs from S3: `url()` needs `publicUrl` (a custom domain or the r2.dev subdomain — R2 has no derivable public URL); `temporaryUrl()` needs the optional `presign` credentials, and throws with guidance otherwise (bindings cannot sign URLs); `setVisibility()` / `put({ visibility })` throw when asked for the opposite of the bucket's declared `visibility`, because R2 has no per-object ACL to honour the request with. `putFile()` throws — Workers has no filesystem.

- **`cloudflarePlugin()`** — the service provider factory, registered automatically by `guren plugin`.

## Things Workers changes

Workers has no filesystem and shares no memory between requests, so a few defaults do not apply:

- **Sessions and OAuth state must be database-backed.** Each request may land on a different isolate. The in-memory defaults work locally and then drop every session in production. Use `DatabaseSessionStore` and `DatabaseOAuthStateStore`.
- **Migrations are applied out of band.** `wrangler d1 migrations apply` owns the lifecycle; the app never migrates itself.
- **`APP_KEY` is required.** Sessions and CSRF are signed with it, and the worker throws at startup without it.

See the [Cloudflare Workers deployment guide](https://guren.dev/docs/guides/cloudflare) for the full path from an empty account to a deployed app, including D1 setup, secrets, free-plan limits, and local development.

## License

MIT

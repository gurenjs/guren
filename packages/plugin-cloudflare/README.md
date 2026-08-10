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

- **`createWorkersHandler(app)`** — wraps a Guren `Application` in a Workers module handler. Boot is lazy and deduplicated on the first request, because `boot()` performs I/O that workerd forbids in global scope. The handler deduplicates boot itself, so boot-once holds for anything matching `WorkersAppLike`, not only Guren's `Application`.
- **`getWorkersEnv<Env>()`** — exposes the first request's bindings to boot-time config through a write-once holder. workerd can also expose bindings at module scope via `cloudflare:workers`, but importing that from shared config would break every other runtime (Bun, Lambda, Vercel) — the holder keeps `config/*.ts` portable. Use it to hand a D1 binding to the ORM:

  ```typescript
  import { createD1Database } from '@guren/core'
  import { getWorkersEnv } from '@guren/plugin-cloudflare'

  const database = createD1Database({
    binding: () => getWorkersEnv<{ DB: unknown }>().DB,
  })
  ```

  The binding is a resolver, not a value — it must be read lazily.

- **`cloudflarePlugin()`** — the service provider factory, registered automatically by `guren plugin`.

## Things Workers changes

Workers has no filesystem and shares no memory between requests, so a few defaults do not apply:

- **Sessions and OAuth state must be database-backed.** Each request may land on a different isolate. The in-memory defaults work locally and then drop every session in production. Use `DatabaseSessionStore` and `DatabaseOAuthStateStore`.
- **Migrations are applied out of band.** `wrangler d1 migrations apply` owns the lifecycle; the app never migrates itself.
- **`APP_KEY` is required.** Sessions and CSRF are signed with it, and the worker throws at startup without it.

See the [Cloudflare Workers deployment guide](https://guren.dev/docs/guides/cloudflare) for the full path from an empty account to a deployed app, including D1 setup, secrets, free-plan limits, and local development.

## License

MIT

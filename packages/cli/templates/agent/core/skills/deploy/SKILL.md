---
name: deploy
description: "Ship the app to production: Docker, Fly.io and Railway recipes from guren deploy, the Vercel, AWS Lambda and Cloudflare Workers plugins, and the production checklist (\"deploy\", \"Dockerfile\", \"put this in Docker\", \"deploy to Vercel\", \"ship to Cloudflare\", \"Lambda\", \"Fly.io\", \"Railway\", \"production\", \"go live\")."
---

# Deploy Skill

Pick the target first: the recipe, the build command and the stores the app
needs all follow from it. Never hand-write a Dockerfile adapted from another
Bun project; the generated one copies exactly what `bun bin/serve.ts` reads.

## 1. Pick the target

| Target | How | Build |
|--------|-----|-------|
| Docker | `bunx guren deploy --target docker` | `docker build` |
| Fly.io | `bunx guren deploy --target fly --app <name>` | the Dockerfile (`fly.toml`) |
| Railway | `bunx guren deploy --target railway` | the Dockerfile (`railway.json`) |
| Vercel (SSR apps only; API-only apps use Docker or Lambda) | `@guren/plugin-vercel` | `bun run vercel:build` |
| AWS Lambda | `@guren/plugin-lambda` | `bunx guren lambda:build` |
| Cloudflare Workers + D1 | `@guren/plugin-cloudflare` | `bunx guren cloudflare:build` |

## 2a. Container recipes (Docker, Fly.io, Railway)

`docker` is the default target; `--target all --app my-app` writes all three.
`--target cloudflare` writes a GitHub Actions workflow, `deploy-cloudflare.yml`
under `.github/workflows/`, which runs `cloudflare:deploy` (needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
repository secrets). `--target vercel` is rejected: use the plugin.

- The Dockerfile is two stages: the builder installs every dependency and runs
  `bun run build`; the runtime stage runs `bun install --frozen-lockfile --production`,
  copies the runtime entries (`tsconfig.json`, `bin/`, `src/`, `app/`,
  `config/`, `routes/`, `modules/`, `db/`, `lang/`, `public/`, `.guren/`) and
  starts `CMD ["bun", "bin/serve.ts"]` under `ENV NODE_ENV=production`.
- Both stages use the running Bun release pinned by digest
  (`oven/bun:<version>@sha256:…`). Do not edit it back to `oven/bun:1`. To move
  Bun, upgrade Bun and rerun with `--force`. When Docker Hub has no image for
  the release yet, the command writes the floating `oven/bun:1` and says so.
- `--port` defaults to 3333. `fly.toml` health-checks `GET /health`, the route
  the scaffold ships in `routes/web.ts`; keep it.
- The command writes nothing when a file it would write exists. Rerun with
  `--force` after a Guren upgrade, then reapply the app's own edits.
- `storage/` is not copied: uploads belong on a volume or object storage.
- Fly secrets: `fly secrets set NAME=value`, never in `fly.toml`.

Test the image locally (the image holds no `.env`):

```bash
docker build -t my-app .
docker run -p 3333:3333 --env-file .env.production my-app
```

## 2b. Serverless plugins

```bash
bunx guren plugin @guren/plugin-vercel       # or plugin-lambda, plugin-cloudflare
bun add @guren/plugin-vercel
```

`guren plugin` checks compatibility, registers the provider in `src/app.ts`
and scaffolds the entry. Then build:

```bash
# Vercel: src/vercel.ts, scripts/vercel-build.ts, vercel.json
bun run vercel:build
vercel deploy --prebuilt

# Lambda: src/lambda.ts; writes .lambda/ (function/, assets/, env.json)
bunx guren lambda:build          # --zip also writes function.zip
# infrastructure: GurenLambdaApp from @guren/plugin-lambda/cdk

# Cloudflare Workers: wrangler.jsonc on the first build; writes .cloudflare/
bunx guren cloudflare:build
bunx wrangler deploy
bunx guren cloudflare:deploy --plan  # plan the one-run deploy (build, D1, migrations), deploy nothing
bunx guren cloudflare:deploy --yes   # that deploy, no prompt (--ci in CI)
```

On Workers, switch `config/database.ts` before the first build: `createD1Database({ binding: 'DB', … })`
when `isWorkersRuntime()` (from `@guren/plugin-cloudflare/env`), the local SQLite factory
otherwise, and write `db/schema.ts` in the SQLite dialect. The build stubs every other SQL
client, so a config that never calls `createD1Database()` deploys and throws on its first query
(`cloudflare:build` warns). The Cloudflare guide has the full file.

Keep `.lambda/` and `.cloudflare/` out of git; rebuild before every deploy.
Each build runs the deploy-runtime checks from step 4 and warns without failing.

## 3. Production checklist

- `NODE_ENV=production`: HSTS, the `Secure` session cookie, hidden error
  details and the `APP_URL` host allowlist key on it. The Dockerfile and the
  scaffolded `start` script set it; a platform that runs `bun bin/serve.ts`
  itself must set it too.
- `APP_KEY`: signs sessions, CSRF and reset tokens, and keys encryption.
  Generate one with `bunx guren key:generate` and put it in the platform's
  secret store (Workers: `bunx wrangler secret put APP_KEY`). The server refuses
  anything but a base64-encoded 32-byte value, so `openssl rand -hex` output fails.
- `APP_URL`: the public base URL. Emailed links (password reset, verification)
  are built from it, not from the request host.
- `DATABASE_URL` (and `PORT` where the platform does not set it).
- Migrations: run them before the new code takes traffic.

  ```bash
  bunx guren db:migrate --dry-run   # judge the pending migrations, apply nothing
  bunx guren db:migrate
  ```

  A refused drop, narrowing or rename follows the `db-manage` skill: ask the
  user before acknowledging data loss. On D1 the app never migrates itself:
  `bunx wrangler d1 migrations apply <db> --remote`.
- Stores: the in-memory session, OAuth state, cache and queue defaults keep
  state per process, so a second container, replica or function invocation
  loses it. Use `bunx guren add session` (database-backed sessions),
  `DatabaseOAuthStateStore` from `@guren/core` (or the Redis one from
  `@guren/core/redis`), and a Redis-backed cache/queue driver
  (`createRedisClient` from `@guren/core/redis`). Workers needs
  `DatabaseSessionStore` and `DatabaseOAuthStateStore`.
- Providers: list them in `createApp({ providers: [...] })` on Lambda, Vercel
  and Workers. `AutoDiscovery` scans the filesystem, which none of them can.
- Hasher on Lambda (Node.js) and Workers: keep the default `Hash`, which writes
  `node:crypto` scrypt. Never select `hasher: 'argon2'` or construct
  `ScryptHasher` or `Argon2Hasher` there; Argon2id rows cannot be verified.
- Secrets: `.env` is git-ignored in a scaffolded app. Keep it that way, and never
  copy `.env` into an image or commit `.env.production`.

## 4. Check before shipping

```bash
bunx guren gate       # codegen, typecheck, lint, check, audit, test
bunx guren doctor     # --strict exits 1 on warnings, --json for keys
bunx guren audit
```

`doctor` (and `check`, advisory) report three deploy verdicts, only for an app
that declares a deploy plugin or the Lambda adapter. A Docker, Fly or Railway
app passes them with "No deploy plugin or Lambda adapter detected", so apply
the checklist above yourself there.

| Key | Means | Fix |
|-----|-------|-----|
| `deploy-password-hashing` | A Bun-only hasher on Lambda or Workers (Vercel runs Bun) | Drop `hasher: 'argon2'`, replace `new ScryptHasher()` with `new Hash()`; have Argon2id users log in under Bun first or reset them |
| `deploy-runtime-stores` | A per-process session, OAuth, cache or queue store | The store fixes in the checklist; a session `default` naming an undeclared store goes under `stores` |
| `deploy-provider-discovery` | `AutoDiscovery` on a target with no filesystem to scan | List providers in `createApp({ providers: [...] })` |
| `deploy-password-hashing-unverified`, `deploy-runtime-stores-unverified` | Introspection could not vouch for the fact | Run `bunx guren introspect` and make the provider it names register cleanly |

None of these fail a build: read each warning and fix it or tell the user why it stands.
Fix every `guren audit` failure before deploying (the `dependencies` skill covers `deps:*`).

## Never

- Bundle a server entry with bare `--minify`. Guren keys queued jobs, events,
  notifications and attachment owners on class names. With `bun build` use
  `--minify-whitespace --minify-syntax --keep-names`; with esbuild,
  `keepNames: true`. On Workers never set `"keep_names": false`
  (`cloudflare:build` refuses it).
- Bundle without `--define 'process.env.NODE_ENV="production"'`: `bun build`
  inlines `"development"` and runtime env cannot override it. The plugin builds
  pass it for you.
- Re-externalize `react` or `@inertiajs/react` from the SSR build. Function
  directories ship no `node_modules`, so SSR silently falls back to the client.
  The Guren Vite plugin's `ssr.noExternal: true` is the right default.
- Commit `.env`, bake it into an image, or print secrets in build logs.
- Serve static assets from the Lambda function; they go to S3 and CloudFront.

Full guides: https://guren.dev/docs/guides/deployment,
https://guren.dev/docs/guides/deploy-production, https://guren.dev/docs/guides/cloudflare.

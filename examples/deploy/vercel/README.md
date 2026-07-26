# Deploy to Vercel

This recipe deploys a Guren application to [Vercel](https://vercel.com) using `@guren/plugin-vercel`, which assembles a [Build Output API](https://vercel.com/docs/build-output-api/v3) directory that runs on Vercel's Bun runtime.

## Prerequisites

- [Vercel CLI](https://vercel.com/docs/cli) installed and authenticated
- An SSR application (the plugin reads Vite manifests; API-only apps should use Docker or Lambda instead)
- A managed database — the function filesystem is not durable, so SQLite files do not survive

## Steps

### 1. Install the plugin

```bash
bunx guren plugin @guren/plugin-vercel
bun add @guren/plugin-vercel
```

The CLI scaffolds `src/vercel.ts`, `scripts/vercel-build.ts`, and `vercel.json`. Copy the `vercel.json` here if you would rather start from this recipe.

### 2. Set environment variables

`APP_KEY` is required — sessions and CSRF are signed with it, and the function throws on startup without one:

```bash
bun -e "console.log('base64:'+Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))" | vercel env add APP_KEY production
vercel env add DATABASE_URL production
```

Add the same values to the `preview` environment if you want pull request deployments to boot.

> [!IMPORTANT]
> Set these **before** the first deployment. A missing `APP_KEY` fails at startup, so every route returns 500 — including pages that never touch a session.

### 3. Deploy

```bash
bun run build
bun run vercel:build
vercel deploy --prebuilt
```

`vercel:build` only assembles `.vercel/output/` — it does not build the app. Run the app build first, or the assembled function has no manifests to read and ships without its asset paths.

Deploying from git instead runs `buildCommand` from `vercel.json`, which chains both steps for you.

### 4. Run migrations

Migrations are applied from your machine or CI, against the same database the function uses:

```bash
DATABASE_URL=<production url> bun run db:migrate
```

## How the Build Works

The plugin bundles your app entry with `process.env.NODE_ENV` substituted at build time — Bun inlines that value when bundling, so setting it at runtime cannot override it.

It also reads the Vite manifests to inject asset paths into the function:

| Manifest | Injected variable |
|---|---|
| `public/assets/.vite/manifest.json` | `GUREN_INERTIA_ENTRY`, `GUREN_INERTIA_STYLES` |
| `.guren/ssr/.vite/manifest.json` | SSR entry resolution |

If those variables end up empty, the page still renders but Inertia falls back to client-side rendering — so a build that "succeeds" can silently lose SSR. Check the emitted `.vercel/output/functions/*/.vc-config.json` if you suspect this.

## Why the `rewrites` Entry Is Required

Built assets carry the Guren Vite plugin's derived base, `/public/assets/` — chunk imports, CSS urls, and preloads all reference that prefix, while the files themselves are copied to the output root. The rewrite maps the prefix back:

```json
{ "source": "/public/(.*)", "destination": "/$1" }
```

Without it the page's entry script still loads — the plugin injects that path directly — but the chunks it imports 404, so the app never starts.

> [!NOTE]
> This entry is compiled into the deployment's routing when **Vercel** runs the build. A `--prebuilt` upload is routed by the `config.json` the plugin emits, which does not carry it — so prefer the git integration, or add the route to the emitted config yourself.

## Notes

- **Serverless functions ship without `node_modules`.** SSR bundles must be self-contained; the Guren Vite plugin defaults `ssr.noExternal` to `true` for SSR builds, so do not re-externalize `react` or `@inertiajs/react`.
- **Use a managed session store.** In-memory sessions do not survive between function instances — see the [Authentication guide](../../../docs/en/guides/authentication.md) for database-backed stores.
- **Static assets** are served from the output directory, so they do not consume function invocations.

For the full deployment reference, see the [Deployment Guide](../../../docs/en/guides/deployment.md).

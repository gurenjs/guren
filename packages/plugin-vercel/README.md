# @guren/plugin-vercel

Deploy a [Guren](https://guren.dev/) SSR application to Vercel. The plugin assembles a [Build Output API v3](https://vercel.com/docs/build-output-api/v3) directory that runs on Vercel's Bun runtime.

```bash
bunx guren plugin @guren/plugin-vercel
bun add @guren/plugin-vercel
```

Installing scaffolds `src/vercel.ts`, `scripts/vercel-build.ts`, and `vercel.json`.

## Build and deploy

```bash
bun run vercel:build
vercel deploy --prebuilt
```

## API

- **`createVercelHandler(app)`** — boots a Guren `Application` and returns a `fetch` handler for the serverless function.

  ```typescript
  // src/vercel.ts
  import app from './app.js'
  import { createVercelHandler } from '@guren/plugin-vercel'

  export default await createVercelHandler(app)
  ```

- **`buildVercelOutput(options)`** — assembles `.vercel/output`: the bundled function, static assets, and the routing config. Reads the Vite manifests to inject the correct `GUREN_INERTIA_*` environment variables into the function.
- **`vercelPlugin()`** — the service provider factory, registered automatically by `guren plugin`.

## Notes

- **SSR apps only.** The plugin reads Vite manifests to wire the Inertia SSR bundle. API-only apps should use Docker or Lambda instead.
- **SSR bundles must be self-contained.** Function directories ship without `node_modules`, so externalized `react`/`@inertiajs/react` imports fail at runtime and Inertia silently falls back to client-side rendering. The Guren Vite plugin defaults `ssr.noExternal: true` for SSR builds — leave it alone unless you know the target has those packages installed.
- **`NODE_ENV` is inlined at bundle time.** `bun build` bakes in `"development"` unless told otherwise, and a runtime `NODE_ENV=production` cannot override it. This plugin passes the right `--define` for you.

See the [deployment guide](https://guren.dev/docs/guides/deployment) for the full setup.

## License

MIT

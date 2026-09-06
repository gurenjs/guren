---
'@guren/cli': minor
'@guren/plugin-agents': patch
---

`make:agent` output typechecks in a fresh app, and `tool:list` finds `routes/api.ts`

`make:agent` now writes what its class needs and never had: `config/env.ts`
with the `Env` interface the scaffold imports (a D1 binding and a commented
slot for the agent's Durable Object namespace — created when absent, left alone
when the file already exports `Env`), the `import type { Env } from
'@/config/env'` line in the class, and `@cloudflare/workers-types` appended in
place to `compilerOptions.types` in `tsconfig.json`. A tsconfig it cannot patch
— no `types` array, comments, none at all — gets the line to paste, and an app
missing the dependency is told to `bun add -d @cloudflare/workers-types`.

`guren tool:list`, `tool:inspect` and `route:list` resolve the routes entry
through the same probe `check` and `audit` use, so an API-only app whose routes
live in `routes/api.ts` works without `--routes`; the flag still overrides.

`@guren/plugin-agents`' README no longer says `make:agent` "writes all three"
of its snippets — the `src/app.ts` registration is the one it leaves to you.

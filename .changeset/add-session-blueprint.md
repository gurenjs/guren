---
'@guren/cli': minor
'@guren/core': minor
'create-guren-app': patch
---

`guren add session`: database-backed sessions in one command (RFC 0020 Part 2b)

A scaffolded app that added authentication kept its sessions in process
memory. That is correct on one long-lived Bun server and drops every login on
Cloudflare Workers, Lambda, or Vercel, where requests share no memory — and it
only reproduces after deploying.

- **`bunx guren add session`** writes the `sessions` table into `db/schema.ts`
  (per dialect, with an `expires_at` index), generates its migration,
  scaffolds `config/session.ts` and `app/Providers/SessionProvider.ts`, wires
  the provider into `createApp()`, registers `sessions:prune` in
  `src/console.ts`, and appends `SESSION_DRIVER` to `.env.example`. An existing
  `sessions` table or `config/session.ts` is left alone.
- **`guren add auth` (and `make:auth`) runs it**, before generating its own
  migration, so one drizzle-kit run covers users and sessions. `make:auth
  --session false` opts out.
- **`SessionsPruneCommand`** (`sessions:prune`, from `@guren/core`) sweeps
  expired rows through the bound manager; it fails rather than exiting 0 when
  no manager is bound.
- The scaffolded `.env.example` no longer ships a `SESSION_DRIVER` line that
  nothing read; the blueprint adds it when it adds the config that reads it.

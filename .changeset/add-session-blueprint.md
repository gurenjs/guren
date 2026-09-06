---
'@guren/cli': minor
'@guren/core': minor
'@guren/server': minor
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
  `src/console.ts`, and appends `SESSION_DRIVER` to `.env.example` and `.env`.
  An existing `sessions` table or session config is left alone, and an app with
  no `db/schema.ts` gets guidance rather than a config it cannot compile.
- **`guren add auth` (and `make:auth`) runs it**, before generating its own
  migration, so one drizzle-kit run covers users and sessions. `make:auth
  --no-session` opts out, and an app that already binds a `session` manager is
  left alone. Without `--install`, `make:auth` writes the files and leaves
  `src/app.ts` and `src/console.ts` for you, as it always has.
- **`SessionsPruneCommand`** (`sessions:prune`, from `@guren/core`) sweeps
  expired rows through the bound manager; it fails rather than exiting 0 when
  no manager is bound.
- The scaffolded `.env.example` no longer ships a `SESSION_DRIVER` line that
  nothing read; the blueprint adds it when it adds the config that reads it.
- `Command.resolveOptional()` (`@guren/server`): `resolve()` for a service a
  command tolerates being absent, so one does not have to reach past its own
  injected container to a process global.

---
'create-guren-app': patch
---

The `docker-compose.yml` scaffolded for `--db postgres` and `--db mysql` now publishes the database port on `127.0.0.1` only (`127.0.0.1:54322` and `127.0.0.1:33306`), so the shared `guren`/`guren` credentials are no longer reachable from other machines on the network. The default `DATABASE_URL` in `.env`, `config/database.ts` and `drizzle.config.ts` addresses `127.0.0.1` to match. A client on the same machine that connects over IPv6 loopback (`[::1]`, or a `localhost` that resolves only to `::1`) is refused; point it at `127.0.0.1`. Apps scaffolded before this release keep their existing compose file; add `127.0.0.1:` in front of the host port there to get the same binding.

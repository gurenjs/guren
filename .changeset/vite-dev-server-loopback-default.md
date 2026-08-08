---
'@guren/server': patch
---

Stop binding the managed Vite dev server to every interface

`Application.listen()` starts a Vite dev server on every non-production boot,
and both the launcher and `gurenVitePlugin` replaced Vite's localhost-only
default with `host: true`. Vite serves any file under its root — transformed
source for `.ts`/`.tsx`, raw bytes for everything else — with no
authentication, no origin check and no loopback gate. Anyone on the same
network could read a developer's application source, and the scaffold's default
`DATABASE_URL=./data/guren.db` puts the SQLite database inside that root and
outside Vite's `server.fs.deny`, so `GET http://<dev-machine>:5173/data/guren.db`
returned the users table — password hashes included — to any LAN peer.

The framework already treats LAN reachability as in scope: `/_guren/mcp` and
`/_guren/docs` are gated on a loopback socket peer precisely because templates
bind `0.0.0.0`. The dev server it starts itself had no equivalent gate.

`host` is now left unset, so Vite's own default applies and the project's
`vite.config.ts` decides. Exposing the dev server on the network is an explicit
opt-in — `--host`, `server.host` in `vite.config.ts`, or
`app.listen({ vite: { host: true } })`.

`preview.host` is unchanged: `vite preview` serves only `build.outDir`, never
the project root, so it carries none of this.

`resolveViteDevServerConfig()` is exported for callers that need the inline
config the managed dev server would start with.

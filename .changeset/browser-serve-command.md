---
"@guren/cli": minor
---

Add `guren browser:serve` (RFC 0033 §3): starts the app for a browser verification session on `127.0.0.1` with a strict port and the runtime-error collector on, after codegen and only when the introspected app shows its database is local. It refuses `NODE_ENV=production`, a remote or unknown database, and an app that binds none; `--database-url` overrides the started app's `DATABASE_URL` and is judged the same way. It prints `{ origin, pid, collector }` as one JSON line and stops only the app it started.

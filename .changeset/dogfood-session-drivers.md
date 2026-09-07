---
'@guren/cli': patch
---

Say when `SESSION_DRIVER` already names another store (RFC 0020 Part 5)

`guren add session` leaves an env file that already assigns `SESSION_DRIVER`
alone, which is right — the app chose it. It now warns when the value names a
store other than the one it just installed, because the silent version of that
is a `sessions` table and a migration nothing ever writes to.

Found by running the blueprint against `examples/blog`, whose `.env.example`
still carried the dead `SESSION_DRIVER=memory` line: the app came out with a
database store, a migration, and `memory` selected.

Also from the same run: `config/session.ts`'s scaffolded comment was an
11-line block, and scaffolded apps lint with `guren/comment-length` — so
framework-generated code warned in the user's own lint. It is now three blocks
inside the limit.

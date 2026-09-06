---
'@guren/server': minor
---

The `cookie` session driver (RFC 0020 Part 3)

`{ driver: 'cookie' }` keeps the whole session inside the cookie, encrypted
under `APP_KEY` with `APP_PREVIOUS_KEYS` accepted for rotation. It is the one
store that needs no server-side resource — no table, no migration, no Redis, no
Workers binding — so it is the shortest path to sessions that survive on
Workers, Lambda and Vercel.

`SessionStore` grows one optional capability, `inline`, with `encode`/`decode`.
A store that has it keeps the session in the cookie: the middleware writes
`encode()`'s value instead of a signed id and reads the next request's back
through `decode()`, so `read`/`write`/`destroy` are never called. Every other
store is unaffected.

The limits are enforced, not just documented: encoding past 4 KB throws with
the size rather than emitting a cookie the browser silently drops, and `decode`
refuses an expired, tampered, or foreign payload — which is what makes
`ttlSeconds` real when nothing server-side can expire a cookie early. A logout
still cannot revoke a copy the client already has, so anything revocable
belongs in the database with only its id in the session.

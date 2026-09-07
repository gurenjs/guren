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

The limits are enforced, not just documented. `SessionOptions.maxCookieBytes`
(4096 by default, what browsers keep) is measured against the whole `Set-Cookie`
the middleware is about to send — name and attributes included — so a session
cannot pass its own check and then be dropped in transit; `decode` refuses an
expired, tampered, foreign, or unreadably-shaped payload, which is what makes
`ttlSeconds` real when nothing server-side can expire a cookie early. A logout
still cannot revoke a copy the client already has, so anything revocable
belongs in the database with only its id in the session.

`CookieSessionStore` packs its payload as `base64url(iv ‖ tag ‖ ciphertext)`
rather than reusing `Encrypter`'s JSON envelope, which base64s the ciphertext
into JSON and base64s that again: measured 1.4–2.0x the plaintext against
1.8–2.3x, which is a third more session inside the same cookie and fewer bytes
uploaded on every request. Its `read`/`write`/`destroy` throw rather than
answering emptily — there is no keyed store behind a cookie session, and
`SessionManager.store()` is public.

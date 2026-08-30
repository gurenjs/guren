---
"@guren/server": patch
"@guren/testing": patch
---

`Controller.file()` / `files()` report no upload for a request body the form parser cannot decode, instead of crashing the request.

Both helpers parsed the multipart body themselves, unguarded. A body the parser rejects — a `Content-Type: multipart/form-data` carrying no usable boundary, say — made that parse throw a `TypeError`, which escaped the action as a **500** whose body reported the exception and a stack trace. Any route reading an upload was one malformed request away from that, whether or not it also validated a body.

An undecodable body carries no file, so it is now answered as one: `file()` returns `null` and `files()` returns `[]` — the same answers both already give for a field that is simply absent. Callers that already handle "no file was uploaded" need no change; the throw is what goes away.

This finishes the surface started by the empty-object fallback in `parseRequestBody()`, which fixed the body-*validation* paths and named these two as a known exclusion. They stay separate on purpose rather than sharing that fallback: it parses without `{ all: true }` and flattens a repeated field to its first value, so routing the upload helpers through it would silently reduce `files()` to one file per field. The shared rule is a guarded multipart parse of their own, which keeps `{ all: true }`.

Like the fallback it sits beside, the guard does not distinguish whose fault the parse failure was: a body the client could never have sent correctly and a body already consumed upstream — middleware reading `ctx.req.raw` directly, bypassing Hono's cache — both read as "no upload" here. That is deliberate for the same reason, telling the two apart means matching runtime-specific error codes that differ on Bun, Node and Workers. The cost is worth naming: a middleware-ordering bug that used to surface as a loud 500 now reads as an absent file.

**This changes a status code.** A client branching on 500 for a malformed upload now gets whatever the action does with no file — often its own validation error rather than an exception report. Leaking the parser's message and stack to the client was itself part of the old behavior.

`@guren/testing`'s controller mock has the same guard, so a controller test and the runtime give the same answer for an undecodable upload.

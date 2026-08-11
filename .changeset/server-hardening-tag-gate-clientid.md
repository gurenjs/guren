---
'@guren/server': patch
---

Harden the GCM tag length, the debug-page production gate, and SSE client ids

Three defence-in-depth fixes from the framework security review. None closes a
confirmed exploit on a shipped code path; each removes a way one could open.

- **GCM authentication tags are pinned to 16 bytes.** `setAuthTag()` adopts
  whatever length it is handed, and a truncated tag was measurably accepted: a
  payload rewritten with the first 4 bytes of a real tag decrypted successfully,
  dropping forgery resistance from 2^128 to 2^32. Both `createCipheriv` and
  `createDecipheriv` now pass `authTagLength: 16`, and a short tag is rejected
  before any key is tried. Everything the `Encrypter` writes already used the
  full tag, so no existing payload is affected.

- **`debugErrorMiddleware`'s production gate no longer uses an optional chain.**
  The page renders the stack trace, the request, and the process environment,
  and this read is its only guard. The deploy plugins settle it at bundle time
  with `--define 'process.env.NODE_ENV="production"'`, which substitutes one
  exact expression — the optional chain was not it, so on hosts where platform
  vars never reach the process environment the gate answered "not production".
  A source-level test pins the form, matching the MCP and docs-viewer gates.

- **SSE client ids are unguessable, and a stream now records its owner.**
  `POST /broadcasting/auth` takes a `clientId` from the request body, so
  authorizing a channel attached it to whatever stream that id named. Ids were
  `Date.now()` plus a `Math.random()` suffix; they are now 16 random bytes from
  `randomHex`, which is the control that actually stops an attach against
  someone else's stream.

  The ownership check is defence in depth on top of that: the endpoint refuses
  to attach a channel to a stream whose recorded owner differs from the caller.
  Ownership is read from the conventional `id`/`sub`/`userId` field of whatever
  `getUser` returns, and a stream stays attachable when no owner could be
  resolved — both because a stream opened before sign-in has to stay attachable
  for authorize-after-login, and because the two cases are indistinguishable.
  An app whose user objects carry none of those fields gets the unguessable id
  and no second layer.

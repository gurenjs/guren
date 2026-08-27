---
'@guren/server': minor
---

Signed-delivery groundwork (RFC 0015 Part 1).

`signUrl`/`verifySignedUrl` now accept app-relative input (`/path?query`)
and return it relative — previously `signUrl('/path')` threw. Query
canonicalization sorts by code unit instead of the locale-dependent
`localeCompare`, the `expires` parameter must be a plain positive integer
(`NaN`/`Infinity` no longer verify), `signUrl` rejects a non-finite
`expiresIn`, and `verifySignedUrl` returns `false` on malformed input
instead of throwing.

`StorageDriver` gains three additive members: an optional
`getStream?(path, { range? })` streaming read (implemented by
`LocalDriver` and `S3Driver`; callers fall back to buffered `get()` where
absent), an optional `capabilities` declaration (`S3Driver` declares
`{ presignedGet: true }`; absent means none — fail-closed), and an
optional `TemporaryUrlOptions` bag on `temporaryUrl()` whose
`responseContentDisposition`/`responseContentType` map onto S3's
presigned response overrides.

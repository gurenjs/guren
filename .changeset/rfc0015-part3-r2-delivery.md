---
'@guren/plugin-cloudflare': minor
---

R2 support for the signed attachment delivery route (RFC 0015 Part 3).

`R2Driver` implements `getStream(path, { range? })` over the binding's
`get(key, { range })` (normalizing to the global web `ReadableStream` at
the driver boundary; an unsatisfiable range propagates R2's rejection) and
declares `capabilities: { presignedGet: true }` iff `presign` credentials
are configured — a config fact, never a probe. `temporaryUrl()` accepts
the `TemporaryUrlOptions` bag but deliberately ignores the response
overrides: R2's S3 API does not implement GetObject's `response-content-*`
parameters, so per the `TemporaryUrlOptions` contract an app that must
force `Content-Disposition` on an R2 disk uses `serve: 'proxy'`.

With this, private attachments on a binding-only R2 disk work through the
delivery route with no `presign` credentials (the route proxies
`get().body` through the Worker), and presign-configured disks upgrade to
302 redirects automatically. SigV4 signing keys are now cached per
credential and day, cutting the per-presign WebCrypto calls.

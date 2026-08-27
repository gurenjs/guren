---
'@guren/plugin-cloudflare': minor
---

R2 support for the signed attachment delivery route (RFC 0015 Part 3).

`R2Driver` implements `getStream(path, { range? })` over the binding's
`get(key, { range })` (normalizing to the global web `ReadableStream` at
the driver boundary), declares `capabilities: { presignedGet: true }` iff
`presign` credentials are configured — a config fact, never a probe — and
`temporaryUrl()` accepts the `TemporaryUrlOptions` response overrides,
signing `response-content-disposition` / `response-content-type` into the
presigned query so disposition policy survives a redirect to the bucket.

With this, private attachments on a binding-only R2 disk work through the
delivery route with no `presign` credentials (the route proxies
`get().body` through the Worker), and presign-configured disks upgrade to
302 redirects automatically.

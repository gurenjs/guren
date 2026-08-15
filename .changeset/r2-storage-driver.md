---
"@guren/plugin-cloudflare": minor
---

Add `R2Driver`, a storage driver over the Cloudflare R2 bucket binding

`R2Driver` implements the `StorageDriver` contract on top of `env.<BUCKET>`
— the same lazy `binding: () => getWorkersEnv<Env>().BUCKET` contract as
`createD1Database` — so a Guren app on Workers can put files behind
`StorageManager` without provisioning an R2 API token or shipping the AWS
SDK in the worker. Register it with `storage.registerDisk('media', () =>
new R2Driver({ binding, publicUrl }))`; on Bun the same disk name can point
at `LocalStorageDriver`, mirroring the D1/SQLite runtime switch.

Where the binding differs from S3, the driver says so instead of guessing:
`url()` needs `publicUrl` (R2 has no derivable public URL); `temporaryUrl()`
presigns through the optional `aws4fetch` peer when `presign` credentials
are configured and throws with guidance otherwise (bindings cannot sign);
`put({ visibility })` / `setVisibility()` throw when asked for the opposite
of the bucket's declared `visibility` (R2 has no per-object ACL);
`putFile()` throws (no filesystem). Bulk deletes are batched to the
binding's 1000-key limit and listings follow the cursor across pages.

Design and rationale: RFC 0009.

---
"@guren/server": minor
"@guren/cli": minor
---

Let the S3 driver talk to endpoints without object ACLs, and scaffold a switchable disk

`S3Driver` sent `x-amz-acl` on every `PutObject` and reached for
`PutObjectAcl` / `GetObjectAcl` for visibility, which is correct for AWS S3
and wrong for several S3-compatible endpoints. Cloudflare R2 documents both
the header and the ACL operations as unsupported — access there is decided
per bucket — and MinIO deployments vary. The storage guide has recommended
`driver: 's3'` against R2 for a while, so this affected a documented path.

`S3DriverOptions.acl` (default `true`, so nothing changes for AWS) turns the
header off. With `acl: false` visibility becomes a property of the disk:
`getVisibility()` reports the configured `visibility`, and `put({ visibility })`
or `setVisibility()` throw when asked for the other value instead of silently
dropping it — a `setVisibility(path, 'private')` that does nothing on a public
bucket is a leak that looks like success.

Separately, `guren add storage` now scaffolds
`default: process.env.STORAGE_DISK ?? 'local'`, so an app declares its disks
once and selects one per environment. Disks resolve lazily, so declaring a
disk you do not use costs nothing and its credentials are never read.

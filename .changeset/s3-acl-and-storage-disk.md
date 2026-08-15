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

The `StorageDriver` contract now also states what the visibility methods do
for a file that does not exist (they throw) and for a backend without
per-object visibility (report the disk's value, refuse the other one), with
`LocalDriver`'s long-standing deviation recorded in place — aligning it
changes stable default behavior, so it waits for a major.

Separately, `guren add storage` now scaffolds a disk map selected by
`STORAGE_DISK`, so an app declares its disks once and picks one per
environment. The generated provider validates the name at boot: an unknown
one is accepted by `createStorageManager` and only fails when a disk is first
resolved, which can be inside a queued job.

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

The `StorageDriver` contract now states what the visibility methods do,
which four drivers had been answering three different ways: a visibility
call throws when the file does not exist, and a backend without per-object
visibility reports the disk's configured value and refuses the other one
instead of accepting a request it cannot carry out. `R2Driver` and the new
`acl: false` path follow it from the start.

**Deprecated, not changed:** `LocalDriver` has always accepted per-object
visibility requests and done nothing — `put({ visibility })` and
`setVisibility()` against a disk's other value, and either visibility method
against a file that does not exist. It now warns once per process for each
and keeps its current behaviour; these become errors in 3.0.0. What makes a
local file reachable is the disk root and whatever serves it, not a flag on
one file, so those calls were never carried out, they only looked like they
were.

To get ahead of it, declare the visibility on the disk rather than the call:
the scaffolded `public` disk now carries `visibility: 'public'`, and files
that must not be reachable belong on a disk that is not served.
`bunx guren upgrade --check-only` lists the call sites.

Separately, `guren add storage` now scaffolds a disk map selected by
`STORAGE_DISK`, so an app declares its disks once and picks one per
environment. The generated provider validates the name at boot: an unknown
one is accepted by `createStorageManager` and only fails when a disk is first
resolved, which can be inside a queued job.

---
'@guren/core': minor
---

Add the `attachments:prune` sweeper (RFC 0013 Part 3):
`AttachmentsPruneCommand` removes attachment rows whose owning record no
longer exists (resolved through `Model.morphMap`) and, with `--objects`,
storage prefixes under `attachments/` that no row references. Deletion
happens only on positive evidence — unverifiable types, failing existence
queries, and unlistable disks are reported and left untouched — and
`--dry-run` reports without deleting.

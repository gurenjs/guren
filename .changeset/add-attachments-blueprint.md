---
'@guren/cli': minor
---

Add the `guren add attachments` blueprint (RFC 0013 Part 4): appends the
attachments table to `db/schema.ts` for the app's dialect, writes
`config/attachments.ts` and an `AttachmentsProvider` that wires
`configureAttachments()` at boot, registers the `attachments:prune`
console command, and installs the storage blueprint first when the app has
no `StorageProvider`.
